// POST /sos — women's-safety SOS session (docs/CONTRACT-1B.md §SOS; request/response = src/lib/sos.ts).
// Actions: start | chunk | alert | location | end | evidence. Every action is idempotent:
//   start twice = same session; chunk (session, seq) is processed once; escalation happens once per session
//   (atomic claim on sos_sessions.alerted_at); end on an ended session is a no-op.
// Escalation creates a PRIVATE safety cluster + report (never on the public map) and routes ONLY to police
// (route.ts routeToPolice). The user's own 'sos_logged' notification is in-app only (no push: SOS is silent).
// AI failures never reach the client: transcription failure = no_speech, threat AI failure = keyword result.
import { transcribe } from '../_shared/ai.ts'
import { GEO_BIAS } from '../_shared/config.ts'
import { isValidLatLng, parsePoint, pointWkt } from '../_shared/geocode.ts'
import { background, HttpError, json, readJson, serve } from '../_shared/http.ts'
import { notifyUsers } from '../_shared/notify.ts'
import { listRouted, routeToPolice, SOS_LOGGED } from '../_shared/route.ts'
import { adminClient, requireUser, type SupabaseClient } from '../_shared/supabase.ts'
import {
  isThreatLevel,
  keywordReason,
  keywordThreat,
  maxThreat,
  threatCheck,
  type ThreatLevel,
  type ThreatResult,
} from '../_shared/threat.ts'
import type { RoutedOrg } from '../_shared/types.ts'

// ---------------------------------------------------------------- types (mirror src/lib/sos.ts)

type SosTrigger = 'button' | 'volume' | 'shake' | 'shortcut'
type SosStatus = 'monitoring' | 'alerted' | 'safe' | 'cancelled' | 'resolved'

interface SosResponse {
  session_id: string
  status: SosStatus
  threat_level: ThreatLevel
  alerted: boolean
  routed?: { org_name: string; org_type: string; distance_m: number }[]
  transcript?: string
  no_speech?: boolean
  reason_en?: string
  reason_ur?: string
  evidence?: { seq: number; url: string; transcript: string | null; threat_level: ThreatLevel; created_at: string }[]
}

interface SessionRow {
  id: string
  user_id: string
  trigger: string
  status: SosStatus
  started_at: string | null
  ended_at: string | null
  alerted_at: string | null
  last_location: unknown
  last_location_at: string | null
  last_accuracy_m: number | null
  threat_level: string | null
  threat_reason: string | null
  transcript: string | null
  cluster_id: string | null
}

interface ChunkRow {
  seq: number
  audio_path: string
  transcript: string | null
  threat_level: string | null
  created_at: string
}

type Point = { lat: number; lng: number; accuracy_m?: number }

const SESSION_COLS = 'id, user_id, trigger, status, started_at, ended_at, alerted_at, last_location, last_location_at, last_accuracy_m, ' +
  'threat_level, threat_reason, transcript, cluster_id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRIGGERS: SosTrigger[] = ['button', 'volume', 'shake', 'shortcut']
const ACTIVE: SosStatus[] = ['monitoring', 'alerted']
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const WINDOW_CHUNKS = 3
const MAX_TRANSCRIPT_CHARS = 20000
const EVIDENCE_TTL_S = 3600
const MANUAL_REASON = { en: 'User pressed Send alert', ur: 'صارف نے الرٹ بھیجنے کا بٹن دبایا' }

const TRIGGER_LABEL: Record<SosTrigger, { en: string; ur: string }> = {
  button: { en: 'SOS button', ur: 'ایس او ایس بٹن' },
  volume: { en: 'Volume buttons', ur: 'والیوم بٹن' },
  shake: { en: 'Phone shake', ur: 'فون ہلانا' },
  shortcut: { en: 'App shortcut', ur: 'ایپ شارٹ کٹ' },
}


// ---------------------------------------------------------------- small helpers

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function asTrigger(v: unknown): SosTrigger {
  return TRIGGERS.includes(v as SosTrigger) ? (v as SosTrigger) : 'button'
}

function asLevel(v: unknown): ThreatLevel {
  return isThreatLevel(v) ? v : 'none'
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function readPoint(b: Record<string, unknown>): Point | null {
  const lat = num(b.lat)
  const lng = num(b.lng)
  if (lat === undefined || lng === undefined || !isValidLatLng(lat, lng)) return null
  const acc = num(b.accuracy_m)
  return { lat, lng, accuracy_m: acc !== undefined && acc >= 0 ? Math.round(acc) : undefined }
}

function safeAudioPath(p: string): boolean {
  return p.length <= 400 && !p.startsWith('/') && !p.includes('..') && !p.includes('\\') && !/[\0\r\n]/.test(p)
}

function audioMime(path: string, blobType: string): string {
  if (blobType && /^(audio|video)\//.test(blobType)) return blobType.split(';')[0]
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    mp3: 'audio/mpeg', mpeg: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', '3gp': 'audio/3gpp',
  }
  return map[ext] ?? 'audio/webm'
}

/** Known STT hallucinations on silence / noise. */
const HALLUCINATION = [
  /thanks?\s*(you)?\s*for\s*watching/i,
  /\bsubscribe\b/i,
  /^\s*(?:شکریہ|thank\s*you|thanks)[.!۔\s]*$/i,
  /^\s*[[(]?\s*(?:music|موسیقی|silence|noise|inaudible|blank_audio|no speech)\s*[\])]?[.\s]*$/i,
  /^[\s♪♫.…,!?۔]*$/,
]

/** True when a chunk transcript has no usable speech (screaming markers / distress keywords always count). */
function isNoSpeech(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return true
  if (keywordThreat(t).level === 'high') return false
  if (HALLUCINATION.some((re) => re.test(t))) return true
  const words = t.replace(/[[(][^\])]*[\])]/g, ' ').split(/\s+/).filter((w) => /\p{L}/u.test(w))
  return words.length === 0
}

function toResponseRouted(r: RoutedOrg[]): NonNullable<SosResponse['routed']> {
  return r.map((o) => ({ org_name: o.org_name, org_type: o.org_type, distance_m: o.distance_m }))
}

function capTail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max)
}

function log(o: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: 'sos', ...o }))
}

// ---------------------------------------------------------------- session access

async function loadSession(admin: SupabaseClient, id: string): Promise<SessionRow | null> {
  const { data, error } = await admin.from('sos_sessions').select(SESSION_COLS).eq('id', id).maybeSingle()
  if (error) throw new Error(`sos session lookup failed: ${error.message}`)
  return (data as unknown as SessionRow) ?? null
}

/** Insert (idempotent on id) and return the caller's session. */
async function ensureSession(
  admin: SupabaseClient,
  userId: string,
  id: string,
  trigger: SosTrigger,
  p: Point | null,
): Promise<{ session: SessionRow; created: boolean }> {
  const existing = await loadSession(admin, id)
  if (existing) {
    if (existing.user_id !== userId) throw new HttpError(403, 'This SOS session belongs to someone else', 'forbidden')
    return { session: existing, created: false }
  }
  const now = new Date().toISOString()
  const { data, error } = await admin.from('sos_sessions').insert({
    id,
    user_id: userId,
    trigger,
    status: 'monitoring',
    started_at: now,
    threat_level: 'none',
    ...(p ? { last_location: pointWkt(p.lat, p.lng), last_location_at: now, last_accuracy_m: p.accuracy_m ?? null } : {}),
  }).select(SESSION_COLS).single()
  if (error) {
    if (error.code === '23505') {
      const again = await loadSession(admin, id)
      if (again && again.user_id === userId) return { session: again, created: false }
      throw new HttpError(403, 'This SOS session belongs to someone else', 'forbidden')
    }
    throw new Error(`sos session insert failed: ${error.message}`)
  }
  return { session: data as unknown as SessionRow, created: true }
}

function baseResponse(s: SessionRow, extra: Partial<SosResponse> = {}): SosResponse {
  return {
    session_id: s.id,
    status: s.status,
    threat_level: asLevel(s.threat_level),
    alerted: Boolean(s.alerted_at) || s.status === 'alerted',
    ...extra,
  }
}

/** Store the latest point on the session and, once alerted, move the private pin (police map follows). */
async function updateLocation(admin: SupabaseClient, s: SessionRow, p: Point): Promise<void> {
  const now = new Date().toISOString()
  const wkt = pointWkt(p.lat, p.lng)
  const jobs: PromiseLike<{ error: { message: string } | null }>[] = [
    admin.from('sos_sessions')
      .update({ last_location: wkt, last_location_at: now, last_accuracy_m: p.accuracy_m ?? null, updated_at: now })
      .eq('id', s.id),
  ]
  if (s.cluster_id) {
    jobs.push(admin.from('clusters').update({ centroid: wkt, updated_at: now }).eq('id', s.cluster_id).eq('is_private', true))
    jobs.push(
      admin.from('reports').update({ location: wkt, location_source: 'gps', updated_at: now })
        .eq('cluster_id', s.cluster_id).eq('is_private', true),
    )
  }
  const res = await Promise.all(jobs)
  for (const r of res) if (r.error) console.warn('[sos] location update failed', r.error.message)
  s.last_location = wkt
  s.last_location_at = now
  s.last_accuracy_m = p.accuracy_m ?? null
}

// ---------------------------------------------------------------- escalation

interface EscalateInput {
  reason_en: string
  reason_ur: string
  phrases: string[]
  manual: boolean
  point: Point | null
  language?: string
  transcriptWindow?: string
}

function attr(
  key: string, label_en: string, label_ur: string, value_en: string, value_ur: string, icon: string,
  severity: 'info' | 'warn' | 'danger', source: 'user' | 'ai',
) {
  return { key, label_en, label_ur, value_en: value_en.slice(0, 120), value_ur: value_ur.slice(0, 120), icon, severity, source }
}

function quoteList(phrases: string[], max = 4): string {
  return phrases.slice(0, max).map((p) => `“${p}”`).join(', ')
}

function buildSummary(
  reason_en: string, reason_ur: string, phrases: string[], trig: { en: string; ur: string },
): { summary_en: string; summary_ur: string } {
  const quoted = quoteList(phrases, 3)
  return {
    summary_en: [reason_en.replace(/[.\s]+$/, '') + '.', quoted ? `Heard: ${quoted}.` : '', `Trigger: ${trig.en}.`]
      .filter(Boolean).join(' ').slice(0, 400),
    summary_ur: [reason_ur.replace(/[۔.\s]+$/, '') + '۔', quoted ? `سنا گیا: ${quoted}۔` : '', `ذریعہ: ${trig.ur}۔`]
      .filter(Boolean).join(' ').slice(0, 400),
  }
}

/** After a fast (keyword) escalation, replace the private pin's reason/summary with the AI's clearer one. */
async function refineEscalation(admin: SupabaseClient, s: SessionRow, check: ThreatResult): Promise<void> {
  if (!s.cluster_id || !check.meta || check.threat_level === 'none' || !check.reason_en) return
  const { summary_en, summary_ur } = buildSummary(check.reason_en, check.reason_ur, check.phrases.slice(0, 6),
    TRIGGER_LABEL[asTrigger(s.trigger)])
  const now = new Date().toISOString()
  const patch = { ai_reason: check.reason_en, summary_en, summary_ur, updated_at: now }
  const res = await Promise.all([
    admin.from('clusters').update(patch).eq('id', s.cluster_id).eq('is_private', true),
    admin.from('reports').update(patch).eq('cluster_id', s.cluster_id).eq('is_private', true),
  ])
  for (const r of res) if (r.error) console.warn('[sos] refine escalation failed', r.error.message)
}

/** Wait briefly for a concurrent escalation (that won the claim) to attach its cluster. */
async function waitForCluster(admin: SupabaseClient, id: string): Promise<SessionRow | null> {
  for (let i = 0; i < 8; i++) {
    const s = await loadSession(admin, id)
    if (!s || s.cluster_id || !s.alerted_at) return s
    await new Promise((r) => setTimeout(r, 500))
  }
  return await loadSession(admin, id)
}

/**
 * Escalate once: claim sos_sessions.alerted_at atomically, create the private cluster + report, route to police,
 * log a 'sos_logged' notification for the user (in-app only). Returns the updated session + police routed.
 */
async function escalate(
  admin: SupabaseClient,
  s: SessionRow,
  input: EscalateInput,
  allowFrom: SosStatus[],
): Promise<{ session: SessionRow; routed: RoutedOrg[] }> {
  if (s.alerted_at || s.cluster_id) {
    const cur = s.cluster_id ? s : (await waitForCluster(admin, s.id)) ?? s
    return { session: cur, routed: cur.cluster_id ? await listRouted(cur.cluster_id) : [] }
  }
  const t0 = performance.now()
  const now = new Date().toISOString()
  const { data: claimed, error: claimErr } = await admin.from('sos_sessions')
    .update({ status: 'alerted', alerted_at: now, ended_at: null, updated_at: now })
    .eq('id', s.id).is('alerted_at', null).in('status', allowFrom)
    .select(SESSION_COLS).maybeSingle()
  if (claimErr) throw new Error(`sos claim failed: ${claimErr.message}`)
  if (!claimed) {
    const cur = (await waitForCluster(admin, s.id)) ?? s
    return { session: cur, routed: cur.cluster_id ? await listRouted(cur.cluster_id) : [] }
  }
  const release = async () => {
    const { error } = await admin.from('sos_sessions')
      .update({ status: s.status, alerted_at: null, ended_at: s.ended_at, updated_at: new Date().toISOString() })
      .eq('id', s.id).eq('alerted_at', now).is('cluster_id', null)
    if (error) console.error('[sos] claim release failed', error.message)
  }

  // ---- location: this request, else the session's last point, else the twin-cities centre (flagged)
  const last = parsePoint(s.last_location)
  const loc: Point | null = input.point ??
    (last ? { lat: last.lat, lng: last.lng, accuracy_m: s.last_accuracy_m != null ? Math.round(s.last_accuracy_m) : undefined } : null)
  const where = loc ?? { lat: GEO_BIAS.lat, lng: GEO_BIAS.lng }
  const wkt = pointWkt(where.lat, where.lng)
  const trig = TRIGGER_LABEL[asTrigger(s.trigger)]
  const phrases = input.phrases.slice(0, 6)
  const quoted = quoteList(phrases, 3)

  const attributes = {
    threat_phrases: attr(
      'threat_phrases', 'Words heard', 'سنے گئے الفاظ',
      phrases.length ? quoteList(phrases) : input.manual ? 'Manual alert — no words needed' : 'Threat detected in audio',
      phrases.length ? quoteList(phrases) : input.manual ? 'دستی الرٹ — الفاظ ضروری نہیں' : 'آڈیو میں خطرہ محسوس ہوا',
      'shield-alert', 'danger', input.manual && !phrases.length ? 'user' : 'ai',
    ),
    trigger: attr(
      'trigger', 'Triggered by', 'کیسے شروع ہوا',
      input.manual ? `${trig.en} · Send alert pressed` : trig.en,
      input.manual ? `${trig.ur} · الرٹ بٹن دبایا` : trig.ur,
      'siren', 'warn', 'user',
    ),
    live_location: attr(
      'live_location', 'Live location', 'موجودہ مقام',
      loc
        ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}${loc.accuracy_m !== undefined ? ` (±${loc.accuracy_m} m)` : ''} · live`
        : 'Not shared yet — approximate city centre',
      loc
        ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}${loc.accuracy_m !== undefined ? ` (±${loc.accuracy_m} میٹر)` : ''} · براہ راست`
        : 'ابھی شیئر نہیں ہوا — اندازاً شہر کا مرکز',
      'map-pin', loc ? 'info' : 'warn', 'user',
    ),
  }
  const title_en = 'SOS — possible threat'
  const title_ur = 'ایس او ایس — ممکنہ خطرہ'
  const { summary_en, summary_ur } = buildSummary(input.reason_en, input.reason_ur, phrases, trig)
  const aiReason = input.manual ? MANUAL_REASON.en : input.reason_en

  let clusterId: string | null = null
  let reportId: string | null = null
  let createdCluster = false
  try {
    const clientId = `sos:${s.id}`
    // a previous attempt may have created the report already (e.g. claim released after a later failure)
    const { data: prior } = await admin.from('reports').select('id, cluster_id')
      .eq('reporter_id', s.user_id).eq('client_id', clientId).maybeSingle()
    if (prior && (prior as { cluster_id: string | null }).cluster_id) {
      reportId = (prior as { id: string }).id
      clusterId = (prior as { cluster_id: string }).cluster_id
    } else {
      const { data: c, error: cErr } = await admin.from('clusters').insert({
        category: 'safety',
        urgency: 'critical',
        centroid: wkt,
        status: 'unconfirmed',
        confidence: 0,
        ai_reason: aiReason,
        title_en,
        title_ur,
        summary_en,
        summary_ur,
        is_private: true,
        sos_session_id: s.id,
        attributes,
        user_urgency: 'emergency',
        last_report_at: now,
      }).select('id').single()
      if (cErr) throw new Error(`sos cluster insert failed: ${cErr.message}`)
      clusterId = (c as { id: string }).id
      createdCluster = true

      const { data: r, error: rErr } = await admin.from('reports').insert({
        reporter_id: s.user_id,
        client_id: clientId,
        cluster_id: clusterId,
        category: 'safety',
        urgency: 'critical',
        title_en,
        title_ur,
        summary_en,
        summary_ur,
        canonical_en: 'sos possible threat to a person',
        transcript: input.transcriptWindow ? capTail(input.transcriptWindow, 4000) : null,
        language: input.language ?? null,
        input_modes: input.transcriptWindow ? ['voice'] : [],
        location: wkt,
        location_source: loc ? 'gps' : 'fallback',
        status: 'unconfirmed',
        confidence: 0,
        ai_reason: aiReason,
        is_spam: false,
        is_private: true,
        attributes,
        user_urgency: 'emergency',
        extraction: {
          sos: {
            session_id: s.id,
            trigger: asTrigger(s.trigger),
            manual: input.manual,
            phrases,
            reason_en: input.reason_en,
            reason_ur: input.reason_ur,
          },
        },
        ai_provider: 'openai',
      }).select('id').single()
      if (rErr) throw new Error(`sos report insert failed: ${rErr.message}`)
      reportId = (r as { id: string }).id

      const { error: pErr } = await admin.from('clusters').update({ primary_report_id: reportId }).eq('id', clusterId)
      if (pErr) console.warn('[sos] primary_report_id update failed', pErr.message)
      const { error: rcErr } = await admin.rpc('recompute_cluster', { p_cluster_id: clusterId })
      if (rcErr) console.warn('[sos] recompute_cluster failed', rcErr.message)
    }

    const { data: upd, error: uErr } = await admin.from('sos_sessions')
      .update({ cluster_id: clusterId, updated_at: new Date().toISOString() })
      .eq('id', s.id).select(SESSION_COLS).single()
    if (uErr) throw new Error(`sos session cluster link failed: ${uErr.message}`)
    s = upd as unknown as SessionRow
  } catch (e) {
    console.error('[sos] escalation persist failed:', errMsg(e))
    if (createdCluster && clusterId) {
      if (reportId) await admin.from('reports').delete().eq('id', reportId)
      await admin.from('clusters').delete().eq('id', clusterId)
    }
    await release()
    throw e
  }
  const cid = clusterId as string

  // ---- police only (find_responders 'safety', verification ignored) — routeToPolice notifies + pushes owners
  let routed: RoutedOrg[] = []
  try {
    routed = await routeToPolice(cid, {
      title_en: 'URGENT SOS — someone may be in danger',
      title_ur: 'فوری ایس او ایس — کسی کی جان کو خطرہ ہو سکتا ہے',
      body_en: `${input.reason_en.replace(/[.\s]+$/, '')}.${quoted ? ` Heard: ${quoted}.` : ''} Live location on your dashboard — respond now.`,
      body_ur: `${input.reason_ur.replace(/[۔.\s]+$/, '')}۔${quoted ? ` سنا گیا: ${quoted}۔` : ''} براہ راست مقام ڈیش بورڈ پر ہے — فوراً پہنچیں۔`,
    })
  } catch (e) {
    console.error('[sos] routeToPolice failed:', errMsg(e))
    routed = await listRouted(cid).catch(() => [])
  }

  // ---- the user's own log entry (in-app only: a push could make a sound on the victim's phone)
  const names = routed.map((o) => o.org_name).filter(Boolean).slice(0, 2).join(', ')
  await notifyUsers([s.user_id], SOS_LOGGED, routed.length
    ? {
      title_en: 'SOS sent to police',
      title_ur: 'ایس او ایس پولیس کو بھیج دیا گیا',
      body_en: `Police alerted with your live location${names ? `: ${names}` : ''}. This alert is saved in your app.`,
      body_ur: `آپ کے موجودہ مقام کے ساتھ پولیس کو اطلاع دے دی گئی${names ? `: ${names}` : ''}۔ یہ الرٹ آپ کی ایپ میں محفوظ ہے۔`,
    }
    : {
      title_en: 'SOS saved — call 15',
      title_ur: 'ایس او ایس محفوظ — 15 پر کال کریں',
      body_en: 'No police team covers this spot in the app yet. Call 15 (Police) if you can.',
      body_ur: 'ایپ میں اس جگہ کے لیے ابھی کوئی پولیس ٹیم نہیں۔ اگر ممکن ہو تو 15 پر کال کریں۔',
    }, {
    cluster_id: cid,
    report_id: reportId,
    url: '/me',
    push: false,
    data: { sos_session_id: s.id, routed: routed.length },
  })

  log({ action: 'escalate', session_id: s.id, cluster_id: cid, manual: input.manual, routed: routed.length,
    has_location: Boolean(loc), ms: Math.round(performance.now() - t0) })
  return { session: s, routed }
}

// ---------------------------------------------------------------- actions

async function actionStart(admin: SupabaseClient, userId: string, id: string, b: Record<string, unknown>): Promise<SosResponse> {
  const p = readPoint(b)
  const { session, created } = await ensureSession(admin, userId, id, asTrigger(b.trigger), p)
  if (!created && p && ACTIVE.includes(session.status)) await updateLocation(admin, session, p)
  log({ action: 'start', session_id: id, created, trigger: session.trigger, has_location: Boolean(p) })
  const routed = session.cluster_id ? toResponseRouted(await listRouted(session.cluster_id)) : undefined
  return baseResponse(session, routed ? { routed } : {})
}

async function actionChunk(
  admin: SupabaseClient, userId: string, id: string, b: Record<string, unknown>,
): Promise<SosResponse> {
  const t0 = performance.now()
  const seq = b.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 100000) {
    throw new HttpError(400, 'seq must be a non-negative integer', 'bad_request')
  }
  const audioPath = typeof b.audio_path === 'string' ? b.audio_path.trim() : ''
  if (!audioPath || !safeAudioPath(audioPath)) throw new HttpError(400, 'Invalid audio_path', 'bad_request')
  if (!audioPath.startsWith(`${userId}/sos/${id}/`)) {
    throw new HttpError(403, 'audio_path must be inside <uid>/sos/<session_id>/', 'forbidden')
  }
  const p = readPoint(b)
  let { session: s } = await ensureSession(admin, userId, id, 'button', p)

  // ---- replay: (session, seq) already processed
  const { data: existing } = await admin.from('sos_chunks').select('seq, audio_path, transcript, threat_level, created_at')
    .eq('session_id', id).eq('seq', seq).maybeSingle()
  if (existing && (existing as ChunkRow).transcript !== null) {
    const row = existing as ChunkRow
    const routed = s.cluster_id ? toResponseRouted(await listRouted(s.cluster_id)) : undefined
    return baseResponse(s, { transcript: row.transcript ?? '', no_speech: !row.transcript, ...(routed ? { routed } : {}) })
  }

  // ---- late chunk after the session ended: keep the audio reference for evidence, skip AI
  if (!ACTIVE.includes(s.status)) {
    if (!existing) {
      const { error } = await admin.from('sos_chunks')
        .upsert({ session_id: id, seq, audio_path: audioPath }, { onConflict: 'session_id,seq', ignoreDuplicates: true })
      if (error) console.warn('[sos] late chunk insert failed', error.message)
    }
    return baseResponse(s, { no_speech: true })
  }

  // ---- location (parallel) + audio → transcript
  const locP = p ? updateLocation(admin, s, p) : Promise.resolve()
  const sttP = (async () => {
    try {
      const { data: blob, error } = await admin.storage.from('report-audio').download(audioPath)
      if (error || !blob) throw new Error(`audio download failed: ${error?.message ?? 'no data'}`)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!bytes.byteLength) return { text: '', language: '' }
      if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('audio chunk too large')
      const r = await transcribe(bytes, audioMime(audioPath, blob.type), 'ur')
      return { text: r.text, language: r.language }
    } catch (e) {
      console.warn('[sos] chunk transcription failed:', errMsg(e))
      return { text: '', language: '', failed: true }
    }
  })()
  const [, stt] = await Promise.all([locP, sttP])
  const sttMs = Math.round(performance.now() - t0)
  const text = stt.text.trim()
  const noSpeech = isNoSpeech(text)

  // ---- persist the chunk (upsert keeps it idempotent)
  const { error: chErr } = await admin.from('sos_chunks').upsert({
    session_id: id,
    seq,
    audio_path: audioPath,
    transcript: noSpeech ? '' : text,
    threat_level: 'none',
  }, { onConflict: 'session_id,seq' })
  if (chErr) console.error('[sos] chunk upsert failed', chErr.message)

  // ---- window = last few chunks with speech; full transcript rebuilt from chunks (robust to out-of-order uploads)
  const { data: rows } = await admin.from('sos_chunks').select('seq, transcript')
    .eq('session_id', id).order('seq', { ascending: true })
  const spoken = ((rows ?? []) as { seq: number; transcript: string | null }[]).filter((r) => r.transcript?.trim())
  const windowText = spoken.filter((r) => r.seq <= seq).slice(-WINDOW_CHUNKS).map((r) => r.transcript!.trim()).join('\n')
  const fullTranscript = capTail(spoken.map((r) => r.transcript!.trim()).join('\n'), MAX_TRANSCRIPT_CHARS)

  // ---- threat check (skip AI when this chunk added no words). A keyword hit escalates at once, with the AI
  //      check running in parallel (it only refines the police-facing reason afterwards).
  let check: ThreatResult | null = null
  let routed: RoutedOrg[] | null = null
  if (!noSpeech && windowText) {
    const kw = keywordThreat(windowText)
    if (kw.level === 'high' && s.status === 'monitoring' && !s.alerted_at) {
      const kr = keywordReason(kw.phrases)
      const [ai, esc] = await Promise.all([
        threatCheck(windowText, stt.language || undefined),
        escalate(admin, { ...s, threat_level: 'high' }, {
          reason_en: kr.en, reason_ur: kr.ur, phrases: kw.phrases, manual: false, point: p,
          language: stt.language || undefined, transcriptWindow: windowText,
        }, ['monitoring']).catch((e) => {
          console.error('[sos] fast escalation failed (retrying below):', errMsg(e))
          return null
        }),
      ])
      check = ai
      if (esc) {
        s = { ...esc.session, threat_level: s.threat_level }
        routed = esc.routed
        background(refineEscalation(admin, s, ai))
      }
    } else {
      check = await threatCheck(windowText, stt.language || undefined)
    }
  }
  const chunkLevel: ThreatLevel = check?.threat_level ?? 'none'
  const sessionLevel = maxThreat(asLevel(s.threat_level), chunkLevel)
  const now = new Date().toISOString()
  const writes: PromiseLike<{ error: { message: string } | null }>[] = [
    admin.from('sos_sessions').update({
      transcript: fullTranscript || null,
      threat_level: sessionLevel,
      ...(check && chunkLevel !== 'none' && check.reason_en ? { threat_reason: check.reason_en } : {}),
      updated_at: now,
    }).eq('id', id),
  ]
  if (chunkLevel !== 'none') {
    writes.push(admin.from('sos_chunks').update({ threat_level: chunkLevel }).eq('session_id', id).eq('seq', seq))
  }
  for (const r of await Promise.all(writes)) if (r.error) console.warn('[sos] chunk bookkeeping failed', r.error.message)
  s = { ...s, transcript: fullTranscript || null, threat_level: sessionLevel,
    threat_reason: check && chunkLevel !== 'none' && check.reason_en ? check.reason_en : s.threat_reason }

  // ---- escalate on 'high' (first time; retried on later chunks if a previous escalation failed)
  if (routed) {
    // already escalated by the fast path above
  } else if (sessionLevel === 'high' && s.status === 'monitoring' && !s.alerted_at) {
    try {
      const reason_en = check?.reason_en || s.threat_reason || 'Threat detected in live audio.'
      const reason_ur = check?.reason_ur || 'براہ راست آڈیو میں خطرہ محسوس ہوا۔'
      const res = await escalate(admin, s, {
        reason_en, reason_ur, phrases: check?.phrases ?? [], manual: false, point: p,
        language: stt.language || undefined, transcriptWindow: windowText,
      }, ['monitoring'])
      s = res.session
      routed = res.routed
    } catch (e) {
      console.error('[sos] auto escalation failed (will retry on next chunk):', errMsg(e))
    }
  } else if (s.cluster_id) {
    routed = await listRouted(s.cluster_id)
  }

  log({
    action: 'chunk', session_id: id, seq, no_speech: noSpeech, stt_failed: Boolean((stt as { failed?: boolean }).failed),
    level: chunkLevel, session_level: sessionLevel, source: check?.source ?? null, ai_model: check?.meta?.model ?? null,
    ai_error: Boolean(check?.ai_error), alerted: Boolean(s.alerted_at), stt_ms: sttMs, ms: Math.round(performance.now() - t0),
  })
  return baseResponse(s, {
    transcript: noSpeech ? '' : text,
    no_speech: noSpeech,
    ...(check && chunkLevel !== 'none' ? { reason_en: check.reason_en, reason_ur: check.reason_ur } : {}),
    ...(routed ? { routed: toResponseRouted(routed) } : {}),
  })
}

async function actionAlert(admin: SupabaseClient, userId: string, id: string, b: Record<string, unknown>): Promise<SosResponse> {
  const p = readPoint(b)
  let { session: s } = await ensureSession(admin, userId, id, 'button', p)
  if (s.status === 'resolved') {
    return baseResponse(s, s.cluster_id ? { routed: toResponseRouted(await listRouted(s.cluster_id)) } : {})
  }
  if (p) await updateLocation(admin, s, p)
  const windowText = (s.transcript ?? '').split('\n').filter(Boolean).slice(-WINDOW_CHUNKS).join('\n')
  const kw = windowText ? keywordThreat(windowText) : null
  let res: { session: SessionRow; routed: RoutedOrg[] }
  try {
    res = await escalate(admin, s, {
      reason_en: MANUAL_REASON.en,
      reason_ur: MANUAL_REASON.ur,
      phrases: kw?.phrases ?? [],
      manual: true,
      point: p,
      transcriptWindow: windowText || undefined,
    }, ['monitoring', 'safe', 'cancelled'])
  } catch (e) {
    throw new HttpError(502, `Could not send the alert, retrying may help: ${errMsg(e)}`, 'escalation_failed')
  }
  s = res.session
  return baseResponse(s, { routed: toResponseRouted(res.routed), reason_en: MANUAL_REASON.en, reason_ur: MANUAL_REASON.ur })
}

async function actionLocation(admin: SupabaseClient, userId: string, id: string, b: Record<string, unknown>): Promise<SosResponse> {
  const p = readPoint(b)
  if (!p) throw new HttpError(400, 'lat and lng are required', 'bad_request')
  const { session: s } = await ensureSession(admin, userId, id, 'button', p)
  if (ACTIVE.includes(s.status)) await updateLocation(admin, s, p)
  return baseResponse(s)
}

async function actionEnd(admin: SupabaseClient, userId: string, id: string, b: Record<string, unknown>): Promise<SosResponse> {
  const outcome = b.outcome
  if (outcome !== 'safe' && outcome !== 'cancelled') throw new HttpError(400, "outcome must be 'safe' or 'cancelled'", 'bad_request')
  const s = await loadSession(admin, id)
  if (!s) throw new HttpError(404, 'SOS session not found', 'not_found')
  if (s.user_id !== userId) throw new HttpError(403, 'This SOS session belongs to someone else', 'forbidden')
  if (!ACTIVE.includes(s.status)) return baseResponse(s)

  const now = new Date().toISOString()
  const { data: upd, error } = await admin.from('sos_sessions')
    .update({ status: outcome, ended_at: now, updated_at: now })
    .eq('id', id).in('status', ACTIVE).select(SESSION_COLS).maybeSingle()
  if (error) throw new Error(`sos end failed: ${error.message}`)
  if (!upd) return baseResponse((await loadSession(admin, id)) ?? s)
  const ended = upd as unknown as SessionRow

  if (s.alerted_at && s.cluster_id) {
    const cid = s.cluster_id
    // mark on the private pin (assignment stays open for police to resolve)
    const { data: c } = await admin.from('clusters').select('attributes').eq('id', cid).maybeSingle()
    const attrs = { ...(((c as { attributes?: Record<string, unknown> } | null)?.attributes) ?? {}) }
    attrs.user_status = attr(
      'user_status', 'User status', 'صارف کی حالت',
      outcome === 'safe' ? 'Marked themselves safe' : 'Cancelled the SOS',
      outcome === 'safe' ? 'خود کو محفوظ بتایا' : 'ایس او ایس منسوخ کیا',
      'info', 'info', 'user',
    )
    const { error: aErr } = await admin.from('clusters').update({ attributes: attrs, updated_at: now }).eq('id', cid)
    if (aErr) console.warn('[sos] cluster user_status update failed', aErr.message)

    const { data: asg } = await admin.from('assignments').select('id, org_id, organizations(owner_id)').eq('cluster_id', cid)
    const owners = ((asg ?? []) as unknown as { organizations: { owner_id: string } | { owner_id: string }[] | null }[])
      .flatMap((a) => Array.isArray(a.organizations) ? a.organizations : a.organizations ? [a.organizations] : [])
      .map((o) => o.owner_id)
    if (owners.length) {
      await notifyUsers(owners, 'status_change', outcome === 'safe'
        ? {
          title_en: 'SOS update: user marked themselves safe',
          title_ur: 'ایس او ایس اپ ڈیٹ: صارف نے خود کو محفوظ بتایا',
          body_en: 'The person who sent the SOS says they are safe now. Please check and resolve the alert.',
          body_ur: 'ایس او ایس بھیجنے والے نے بتایا کہ وہ اب محفوظ ہیں۔ براہ کرم تصدیق کر کے الرٹ مکمل کریں۔',
        }
        : {
          title_en: 'SOS update: user cancelled the alert',
          title_ur: 'ایس او ایس اپ ڈیٹ: صارف نے الرٹ منسوخ کیا',
          body_en: 'The person who sent the SOS cancelled it. Please check and resolve the alert.',
          body_ur: 'ایس او ایس بھیجنے والے نے اسے منسوخ کر دیا۔ براہ کرم تصدیق کر کے الرٹ مکمل کریں۔',
        }, {
        cluster_id: cid,
        url: '/dashboard',
        data: { sos_session_id: id, sos_event: outcome === 'safe' ? 'user_safe' : 'user_cancelled' },
      })
    }
  }
  log({ action: 'end', session_id: id, outcome, was_alerted: Boolean(s.alerted_at) })
  return baseResponse(ended)
}

async function actionEvidence(admin: SupabaseClient, userId: string, id: string): Promise<SosResponse> {
  const s = await loadSession(admin, id)
  if (!s) throw new HttpError(404, 'SOS session not found', 'not_found')

  // ---- access: admin, or owner of a POLICE org with an assignment on the session's cluster
  const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle()
  let allowed = (prof as { role?: string } | null)?.role === 'admin'
  if (!allowed && s.cluster_id) {
    const { data: orgs } = await admin.from('organizations').select('id').eq('owner_id', userId).eq('org_type', 'police')
    const orgIds = ((orgs ?? []) as { id: string }[]).map((o) => o.id)
    if (orgIds.length) {
      const { data: asg } = await admin.from('assignments').select('id').eq('cluster_id', s.cluster_id).in('org_id', orgIds).limit(1)
      allowed = Boolean(asg?.length)
    }
  }
  if (!allowed) throw new HttpError(403, 'Only the assigned police team or an admin can open SOS evidence', 'forbidden')

  const { data: rows, error } = await admin.from('sos_chunks').select('seq, audio_path, transcript, threat_level, created_at')
    .eq('session_id', id).order('seq', { ascending: true })
  if (error) throw new Error(`sos chunks lookup failed: ${error.message}`)
  const chunks = (rows ?? []) as ChunkRow[]
  const urls = new Map<string, string>()
  if (chunks.length) {
    const { data: signed, error: sErr } = await admin.storage.from('report-audio')
      .createSignedUrls(chunks.map((c) => c.audio_path), EVIDENCE_TTL_S)
    if (sErr) console.error('[sos] createSignedUrls failed', sErr.message)
    for (const x of signed ?? []) if (x.path && x.signedUrl && !x.error) urls.set(x.path, x.signedUrl)
  }
  log({ action: 'evidence', session_id: id, chunks: chunks.length, signed: urls.size })
  return baseResponse(s, {
    transcript: s.transcript ?? '',
    evidence: chunks.filter((c) => urls.has(c.audio_path)).map((c) => ({
      seq: c.seq,
      url: urls.get(c.audio_path)!,
      transcript: c.transcript || null,
      threat_level: asLevel(c.threat_level),
      created_at: c.created_at,
    })),
    ...(s.threat_reason ? { reason_en: s.threat_reason } : {}),
  })
}

// ---------------------------------------------------------------- handler

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireUser(req)
  const body = await readJson<Record<string, unknown>>(req)
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be a JSON object', 'bad_request')
  const action = body.action
  const id = typeof body.session_id === 'string' ? body.session_id.trim().toLowerCase() : ''
  if (!UUID.test(id)) throw new HttpError(400, 'session_id must be a uuid', 'bad_request')
  const admin = adminClient()

  switch (action) {
    case 'start':
      return json(await actionStart(admin, user.id, id, body))
    case 'chunk':
      return json(await actionChunk(admin, user.id, id, body))
    case 'alert':
      return json(await actionAlert(admin, user.id, id, body))
    case 'location':
      return json(await actionLocation(admin, user.id, id, body))
    case 'end':
      return json(await actionEnd(admin, user.id, id, body))
    case 'evidence':
      return json(await actionEvidence(admin, user.id, id))
    default:
      throw new HttpError(400, "action must be one of start | chunk | alert | location | end | evidence", 'bad_request')
  }
})
