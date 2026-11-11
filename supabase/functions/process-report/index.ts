// POST /process-report — the core pipeline: voice / photo / text -> AI extraction -> location -> duplicate
// clustering -> verification -> responder routing -> nearby alerts. See docs/CONTRACT.md §2 "process-report".
import { checkPhoto, embed, extractReport, sameIncident, transcribe } from '../_shared/ai.ts'
import {
  DUP_GRAY_ZONE_MIN,
  DUP_RADIUS_M,
  DUP_SIM_THRESHOLD,
  DUP_WINDOW_HOURS,
  FOOD_DEFAULT_SAFE_HOURS,
  GEO_BIAS,
} from '../_shared/config.ts'
import { type GeocodeResult, geocodeReport, isValidLatLng, pointWkt } from '../_shared/geocode.ts'
import { background, HttpError, json, readJson, serve } from '../_shared/http.ts'
import { escalateCluster, listRouted } from '../_shared/route.ts'
import { adminClient, requireUser } from '../_shared/supabase.ts'
import {
  type AiMeta,
  type Category,
  CATEGORIES,
  type Extraction,
  type Lang,
  type PhotoCheck,
  type ProcessReportResponse,
  type Provider,
  type ReportStatus,
  type RoutedOrg,
  type Urgency,
  URGENCIES,
} from '../_shared/types.ts'
import { verifyCluster, type VerifyResult } from '../_shared/verify.ts'

const MAX_IMAGES = 3
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const MAX_TEXT = 4000
const SAME_INCIDENT_CANDIDATES = 2

const REJECTED_MESSAGE = {
  message_en: 'This does not look like a report of a local problem, so it was not added to the map. ' +
    'If it is a real problem, please describe it again.',
  message_ur: 'یہ کسی مقامی مسئلے کی رپورٹ نہیں لگتی، اس لیے اسے نقشے پر شامل نہیں کیا گیا۔ ' +
    'اگر یہ اصل مسئلہ ہے تو براہ کرم دوبارہ بتائیں۔',
}

// ------------------------------------------------------------------------------------------- helpers

interface Body {
  client_id: string
  text: string
  audio_path: string | null
  image_paths: string[]
  point: { lat: number; lng: number } | null
  accuracy_m: number | null
  location_source: 'gps' | 'map' | 'geocoded'
  address_text: string
  language: 'ur' | 'en' | 'pa' | 'auto'
  ui_language: Lang
  category_hint: Category | undefined
}

const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const safePath = (p: string) => p.length > 2 && p.length < 400 && !p.includes('..') && !p.startsWith('/') && !p.includes('\\')

function validate(raw: unknown, userId: string): Body {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Body must be a JSON object', 'bad_request')
  const b = raw as Record<string, unknown>
  const client_id = str(b.client_id, 200)
  if (!client_id) throw new HttpError(400, 'client_id is required', 'bad_request')

  const text = str(b.text, MAX_TEXT)
  const audio_path: string | null = str(b.audio_path, 400) || null
  if (audio_path) {
    if (!safePath(audio_path)) throw new HttpError(400, 'Invalid audio_path', 'bad_request')
    // report-audio is private: a caller may only submit audio from their own folder ({auth.uid()}/...)
    if (!audio_path.startsWith(`${userId}/`)) throw new HttpError(403, 'audio_path must be inside your own folder', 'forbidden')
  }
  const image_paths = Array.isArray(b.image_paths)
    ? [...new Set(b.image_paths.map((p) => str(p, 400)).filter((p) => p && safePath(p)))].slice(0, MAX_IMAGES)
    : []
  if (!text && !audio_path && !image_paths.length) {
    throw new HttpError(400, 'Send a voice note, a photo or some text', 'empty_report')
  }

  const lat = typeof b.lat === 'string' ? Number(b.lat) : b.lat
  const lng = typeof b.lng === 'string' ? Number(b.lng) : b.lng
  const point = isValidLatLng(lat, lng) ? { lat: lat as number, lng: lng as number } : null
  const src = b.location_source
  const location_source = src === 'map' || src === 'geocoded' || src === 'gps' ? src : 'gps'
  const acc = Number(b.accuracy_m)
  const lang = b.language
  const language = lang === 'ur' || lang === 'en' || lang === 'pa' ? lang : 'auto'
  const ui_language: Lang = b.ui_language === 'en' ? 'en' : 'ur'
  const hint = str(b.category_hint, 20) as Category
  return {
    client_id,
    text,
    audio_path,
    image_paths,
    point,
    accuracy_m: Number.isFinite(acc) && acc >= 0 ? acc : null,
    location_source,
    address_text: str(b.address_text, 300),
    language,
    ui_language,
    category_hint: CATEGORIES.includes(hint) ? hint : undefined,
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(s)
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

const URG_RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const maxUrgency = (a: Urgency, b: Urgency): Urgency => (URG_RANK[b] > URG_RANK[a] ? b : a)

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Stage timer: logs each stage's duration; summary at the end. */
function stageTimer(clientId: string) {
  const t0 = performance.now()
  const timings: Record<string, number> = {}
  return {
    timings,
    async run<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const s = performance.now()
      try {
        return await fn()
      } finally {
        timings[stage] = Math.round(performance.now() - s)
        console.log(`[process-report] ${clientId} ${stage} ${timings[stage]}ms`)
      }
    },
    total: () => Math.round(performance.now() - t0),
  }
}

function photoOnlyClaim(hint: Category | undefined): Extraction {
  return {
    category: hint ?? 'other',
    urgency: 'medium',
    title_en: 'Photo-only report',
    title_ur: 'صرف تصویر والی رپورٹ',
    summary_en: 'The citizen sent only a photo, with no words. Describe the local civic problem visible in the photo ' +
      '(what it is, how serious, any landmark or sign that shows the place).',
    summary_ur: 'شہری نے صرف تصویر بھیجی ہے۔',
    canonical_en: '',
    location_hints: [],
    language: 'ur',
    is_spam: false,
    spam_reason: null,
    food: null,
    confidence_notes: 'photo only',
  }
}

/** Last-resort extraction when every AI model is down: keeps the report flowing (pin + routing by hint). */
function basicExtraction(words: string, hint: Category | undefined, uiLang: Lang): Extraction {
  const clean = words.replace(/\s+/g, ' ').trim()
  const title = clean.split(' ').slice(0, 8).join(' ') || 'Citizen report'
  const urdu = /[؀-ۿ]/.test(clean)
  return {
    category: hint ?? 'other',
    urgency: 'medium',
    title_en: urdu ? 'Citizen report' : title,
    title_ur: urdu ? title : 'شہری کی رپورٹ',
    summary_en: urdu ? 'Citizen report (automatic summary unavailable).' : clean.slice(0, 300) || 'Citizen report.',
    summary_ur: urdu ? clean.slice(0, 300) : 'شہری کی رپورٹ (خودکار خلاصہ دستیاب نہیں)۔',
    canonical_en: clean.toLowerCase().slice(0, 200),
    location_hints: [],
    language: urdu ? 'ur' : uiLang === 'en' ? 'en' : 'mixed',
    is_spam: false,
    spam_reason: null,
    food: null,
    confidence_notes: 'AI extraction unavailable: basic fallback',
  }
}

// ------------------------------------------------------------------------------------------- stored result (idempotency)

const REPORT_RESULT_COLS = 'id, cluster_id, category, urgency, status, confidence, ai_reason, title_en, title_ur, ' +
  'summary_en, summary_ur, transcript, is_spam, spam_reason, ai_provider, food_servings, food_type, safe_until, extraction'

interface StoredReport {
  id: string
  cluster_id: string | null
  category: Category
  urgency: Urgency
  status: ReportStatus
  confidence: number
  ai_reason: string | null
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  transcript: string | null
  is_spam: boolean
  spam_reason: string | null
  ai_provider: string | null
  food_servings: number | null
  food_type: string | null
  safe_until: string | null
  extraction: { _pipeline?: { similarity?: number | null } } | null
}

async function storedResult(r: StoredReport): Promise<ProcessReportResponse> {
  const base: ProcessReportResponse = {
    report_id: r.id,
    cluster_id: r.cluster_id,
    is_duplicate: false,
    similarity: r.extraction?._pipeline?.similarity ?? null,
    status: r.status,
    confidence: r.confidence ?? 0,
    category: r.category,
    urgency: r.urgency,
    title_en: r.title_en ?? '',
    title_ur: r.title_ur ?? '',
    summary_en: r.summary_en ?? '',
    summary_ur: r.summary_ur ?? '',
    ai_reason: r.ai_reason,
    routed: [],
    ai_provider: (r.ai_provider ?? 'openai') as Provider,
    transcript: r.transcript ?? undefined,
    food: r.category === 'food' && r.safe_until
      ? { servings: r.food_servings ?? 0, safe_until: r.safe_until, food_type: r.food_type ?? '' }
      : null,
  }
  if (r.is_spam || !r.cluster_id) {
    return { ...base, cluster_id: null, rejected: { reason: r.spam_reason ?? 'not a local civic issue', ...REJECTED_MESSAGE } }
  }
  const [{ data: c }, routed] = await Promise.all([
    adminClient().from('clusters').select('status, confidence, ai_reason, primary_report_id').eq('id', r.cluster_id).maybeSingle(),
    listRouted(r.cluster_id),
  ])
  const cl = c as { status: ReportStatus; confidence: number; ai_reason: string | null; primary_report_id: string | null } | null
  return {
    ...base,
    is_duplicate: Boolean(cl?.primary_report_id && cl.primary_report_id !== r.id),
    status: cl?.status ?? base.status,
    confidence: cl?.confidence ?? base.confidence,
    ai_reason: cl?.ai_reason ?? base.ai_reason,
    routed: routed.map(publicRouted),
  }
}

const publicRouted = (o: RoutedOrg) => ({ org_name: o.org_name, org_type: o.org_type, distance_m: o.distance_m })

async function findExisting(reporterId: string, clientId: string): Promise<StoredReport | null> {
  const { data, error } = await adminClient().from('reports').select(REPORT_RESULT_COLS)
    .eq('reporter_id', reporterId).eq('client_id', clientId).maybeSingle()
  if (error) throw new Error(`idempotency lookup failed: ${error.message}`)
  return (data as unknown as StoredReport) ?? null
}

// ------------------------------------------------------------------------------------------- handler

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireUser(req)
  const body = validate(await readJson<unknown>(req), user.id)
  const admin = adminClient()
  const T = stageTimer(body.client_id)

  // ---- 0. idempotency
  const prior = await T.run('idempotency', () => findExisting(user.id, body.client_id))
  if (prior) {
    console.log(`[process-report] ${body.client_id} replay of stored report ${prior.id}`)
    return json(await storedResult(prior))
  }

  // ---- 1. media: audio -> transcript, images -> data URLs (in parallel)
  const audioP = body.audio_path
    ? T.run('audio', async () => {
      const { data: blob, error } = await admin.storage.from('report-audio').download(body.audio_path!)
      if (error || !blob) throw new Error(`audio download failed: ${error?.message ?? 'no data'}`)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!bytes.byteLength) throw new Error('audio file is empty')
      if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('audio file too large')
      return await transcribe(bytes, audioMime(body.audio_path!, blob.type), body.language)
    }).catch((e) => {
      console.error('[process-report] audio/transcribe failed:', errMsg(e))
      return { error: errMsg(e) }
    })
    : Promise.resolve(null)

  const imagesP = body.image_paths.length
    ? T.run('images', async () => {
      const out = await Promise.all(body.image_paths.map(async (path) => {
        try {
          const { data: blob, error } = await admin.storage.from('report-images').download(path)
          if (error || !blob) throw new Error(error?.message ?? 'no data')
          if (blob.size > MAX_IMAGE_BYTES) throw new Error('image too large')
          const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg'
          return { path, url: `data:${mime};base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}` }
        } catch (e) {
          console.warn('[process-report] image download failed', path, errMsg(e))
          return null
        }
      }))
      return out.filter((x): x is { path: string; url: string } => x !== null)
    })
    : Promise.resolve([] as { path: string; url: string }[])

  const [audioRes, images] = await Promise.all([audioP, imagesP])
  const transcription = audioRes && !('error' in audioRes) ? audioRes : null
  const transcript = transcription?.text?.trim() ?? ''
  const imageUrls = images.map((i) => i.url)
  const hasWords = Boolean(body.text || transcript)

  if (!hasWords && !imageUrls.length) {
    if (audioRes && 'error' in audioRes) {
      throw new HttpError(502, 'Could not process the voice note. Please try again or type it.', 'transcription_failed')
    }
    if (transcription) throw new HttpError(422, 'No speech was heard in the voice note', 'no_speech')
    throw new HttpError(422, 'The photos could not be read. Please send them again.', 'media_unavailable')
  }

  // ---- 2. extraction (photo-only reports: photo first, then extract from the vision description)
  let extraction: Extraction
  let extractMeta: AiMeta | null = null
  let photo: PhotoCheck | null = null
  let visionMeta: AiMeta | null = null
  let extractFallback = false
  if (hasWords) {
    try {
      const r = await T.run('extract', () =>
        extractReport({
          text: body.text || undefined,
          transcript: transcript || undefined,
          uiLanguage: body.ui_language,
          addressText: body.address_text || undefined,
          categoryHint: body.category_hint,
        }))
      extraction = r.data
      extractMeta = r.meta
    } catch (e) {
      console.error('[process-report] extraction failed, basic fallback:', errMsg(e))
      extraction = basicExtraction([transcript, body.text].filter(Boolean).join(' '), body.category_hint, body.ui_language)
      extractFallback = true
    }
  } else {
    try {
      const pc = await T.run('vision_first', () => checkPhoto({ imageUrls, claim: photoOnlyClaim(body.category_hint) }))
      photo = pc.data
      visionMeta = pc.meta
    } catch (e) {
      console.error('[process-report] photo-only vision failed:', errMsg(e))
    }
    try {
      const described = photo
        ? `Photo-only report (the citizen sent no words). An AI vision check describes the photo as: "${photo.notes}" ` +
          `(visible severity: ${photo.severity}${photo.food_type ? `; food: ${photo.food_type}, about ${photo.servings_estimate ?? '?'} servings` : ''}).`
        : undefined
      const r = await T.run('extract', () =>
        extractReport({
          text: described,
          uiLanguage: body.ui_language,
          addressText: body.address_text || undefined,
          categoryHint: body.category_hint,
        }))
      extraction = { ...r.data, language: body.ui_language }
      extractMeta = r.meta
    } catch (e) {
      console.error('[process-report] photo-only extraction failed, basic fallback:', errMsg(e))
      extraction = basicExtraction(photo?.notes ?? '', body.category_hint, body.ui_language)
      extractFallback = true
    }
    // the claim was derived from this very photo
    if (photo && !extraction.is_spam) photo = { ...photo, matches_claim: true }
  }
  const aiProvider = (extractMeta?.provider ?? (extractFallback ? 'none' : 'openai')) as Provider

  const inputModes: string[] = []
  if (transcription) inputModes.push('voice')
  if (images.length) inputModes.push('photo')
  if (body.text) inputModes.push('text')
  const mediaRows = (reportId: string) => [
    ...(body.audio_path ? [{ report_id: reportId, type: 'audio', storage_path: body.audio_path, bucket: 'report-audio' }] : []),
    ...images.map((i) => ({ report_id: reportId, type: 'image', storage_path: i.path, bucket: 'report-images' })),
  ]
  const transcriptOut = transcript || undefined

  // ---- 3. spam: store (no cluster), tell the user kindly
  if (extraction.is_spam) {
    const p = body.point ?? { lat: GEO_BIAS.lat, lng: GEO_BIAS.lng }
    const { data: ins, error } = await admin.from('reports').insert({
      reporter_id: user.id,
      client_id: body.client_id,
      cluster_id: null,
      category: extraction.category,
      urgency: extraction.urgency,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
      canonical_en: extraction.canonical_en,
      transcript: transcript || null,
      language: extraction.language,
      input_modes: inputModes,
      location: pointWkt(p.lat, p.lng),
      location_source: body.point ? body.location_source : 'fallback',
      address_text: body.address_text || null,
      location_hints: extraction.location_hints,
      status: 'unconfirmed',
      confidence: 0,
      is_spam: true,
      spam_reason: extraction.spam_reason ?? 'not a local civic issue',
      photo_check: photo,
      extraction: { ...extraction, _pipeline: { timings_ms: T.timings, extract_model: extractMeta?.model } },
      ai_provider: aiProvider,
    }).select('id').single()
    if (error) {
      if (error.code === '23505') {
        const again = await findExisting(user.id, body.client_id)
        if (again) return json(await storedResult(again))
      }
      throw new Error(`spam report insert failed: ${error.message}`)
    }
    const reportId = (ins as { id: string }).id
    const media = mediaRows(reportId)
    if (media.length) {
      const { error: mErr } = await admin.from('report_media').insert(media)
      if (mErr) console.warn('[process-report] media insert failed', mErr.message)
    }
    console.log(`[process-report] ${body.client_id} rejected as spam (${extraction.spam_reason}) total ${T.total()}ms`)
    const res: ProcessReportResponse = {
      report_id: reportId,
      cluster_id: null,
      is_duplicate: false,
      similarity: null,
      status: 'unconfirmed',
      confidence: 0,
      category: extraction.category,
      urgency: extraction.urgency,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
      ai_reason: null,
      routed: [],
      ai_provider: aiProvider,
      transcript: transcriptOut,
      food: null,
      rejected: { reason: extraction.spam_reason ?? 'not a local civic issue', ...REJECTED_MESSAGE },
    }
    return json(res)
  }

  // ---- 4. in parallel: photo check (claim known), embedding, location
  const photoP: Promise<PhotoCheck | null> = hasWords && imageUrls.length
    ? T.run('vision', () => checkPhoto({ imageUrls, claim: extraction })).then((r) => {
      visionMeta = r.meta
      return r.data
    }).catch((e) => {
      console.error('[process-report] photo check failed:', errMsg(e))
      return null
    })
    : Promise.resolve(photo)
  const embedP = T.run('embed', () => embed(extraction.canonical_en || extraction.summary_en)).catch((e) => {
    console.error('[process-report] embedding failed (no duplicate matching):', errMsg(e))
    return null
  })
  let geocoded: GeocodeResult | null = null
  const locationP: Promise<{ lat: number; lng: number; source: string } | null> = body.point
    ? Promise.resolve({ ...body.point, source: body.location_source })
    : T.run('geocode', () => geocodeReport(body.address_text, extraction.location_hints)).then((g) => {
      geocoded = g
      return g ? { lat: g.lat, lng: g.lng, source: 'geocoded' } : null
    })

  const location = await locationP
  if (!location) {
    console.log(`[process-report] ${body.client_id} needs_location (hints: ${extraction.location_hints.join(' | ')}) total ${T.total()}ms`)
    throw new HttpError(422, 'Where is this? Please pick the place on the map.', 'needs_location', {
      needs_location: { hints: extraction.location_hints },
      transcript: transcriptOut,
      category: extraction.category,
      urgency: extraction.urgency,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
    })
  }
  const [photoCheck, embedding] = await Promise.all([photoP, embedP])

  // photo evidence can raise urgency (never lower it)
  let urgency: Urgency = URGENCIES.includes(extraction.urgency) ? extraction.urgency : 'medium'
  if (photoCheck?.matches_claim && URGENCIES.includes(photoCheck.severity)) urgency = maxUrgency(urgency, photoCheck.severity)

  // food rescue fields
  // (only for food on offer — a "people need food" report has no servings / shelf life)
  const isFood = extraction.category === 'food' &&
    Boolean(extraction.food || photoCheck?.food_type || photoCheck?.servings_estimate)
  const foodServings = isFood ? (photoCheck?.servings_estimate ?? extraction.food?.servings_estimate ?? null) : null
  const foodType = isFood ? (extraction.food?.food_type || photoCheck?.food_type || null) : null
  const safeUntil = isFood
    ? new Date(Date.now() + (extraction.food?.safe_hours || FOOD_DEFAULT_SAFE_HOURS) * 3600_000).toISOString()
    : null

  // ---- 5. duplicate matching
  const vecLiteral = embedding ? `[${embedding.vector.join(',')}]` : null
  let clusterId: string | null = null
  let similarity: number | null = null
  let matchMethod: 'embedding' | 'same_incident' | 'new' = 'new'
  let sameReason: string | null = null
  if (embedding && vecLiteral) {
    const { data: rows, error } = await T.run('match', async () =>
      await admin.rpc('match_cluster', {
        p_category: extraction.category,
        p_lat: location.lat,
        p_lng: location.lng,
        p_embedding: vecLiteral,
        p_embedding_model: embedding.model,
        p_radius_m: DUP_RADIUS_M,
        p_hours: DUP_WINDOW_HOURS,
        p_limit: 5,
      }))
    if (error) console.error('[process-report] match_cluster failed:', error.message)
    const best = new Map<string, { cluster_id: string; report_id: string; similarity: number; distance_m: number }>()
    for (const r of (rows ?? []) as { cluster_id: string; report_id: string; similarity: number; distance_m: number }[]) {
      const s = Number(r.similarity)
      if (!r.cluster_id || !Number.isFinite(s)) continue
      const cur = best.get(r.cluster_id)
      if (!cur || s > cur.similarity) best.set(r.cluster_id, { ...r, similarity: s })
    }
    const ranked = [...best.values()].sort((a, b) => b.similarity - a.similarity)
    if (ranked.length) similarity = Math.round(ranked[0].similarity * 1000) / 1000
    if (ranked[0] && ranked[0].similarity >= DUP_SIM_THRESHOLD) {
      clusterId = ranked[0].cluster_id
      matchMethod = 'embedding'
    } else {
      const gray = ranked.filter((r) => r.similarity >= DUP_GRAY_ZONE_MIN && r.similarity < DUP_SIM_THRESHOLD)
        .slice(0, SAME_INCIDENT_CANDIDATES)
      if (gray.length) {
        const { data: cand } = await admin.from('reports').select('id, canonical_en, summary_en')
          .in('id', gray.map((g) => g.report_id))
        const textOf = new Map(((cand ?? []) as { id: string; canonical_en: string | null; summary_en: string | null }[])
          .map((c) => [c.id, [c.summary_en, c.canonical_en ? `(${c.canonical_en})` : ''].filter(Boolean).join(' ')]))
        const mine = [extraction.summary_en, extraction.canonical_en ? `(${extraction.canonical_en})` : ''].filter(Boolean).join(' ')
        const verdicts = await T.run('same_incident', () =>
          Promise.all(gray.map(async (g) => {
            const other = textOf.get(g.report_id)
            if (!other) return { g, same: false, reason: 'candidate text missing' }
            try {
              const v = await sameIncident(mine, other)
              return { g, same: v.same, reason: v.reason }
            } catch (e) {
              console.warn('[process-report] sameIncident failed:', errMsg(e))
              return { g, same: false, reason: 'adjudication unavailable' }
            }
          })))
        const hit = verdicts.find((v) => v.same)
        if (hit) {
          clusterId = hit.g.cluster_id
          similarity = Math.round(hit.g.similarity * 1000) / 1000
          matchMethod = 'same_incident'
          sameReason = hit.reason
        }
      }
    }
  }
  const isDuplicate = clusterId !== null
  const nowIso = new Date().toISOString()

  // ---- 6. create cluster (new incident)
  let createdCluster = false
  if (!clusterId) {
    const { data: c, error } = await admin.from('clusters').insert({
      category: extraction.category,
      urgency,
      centroid: pointWkt(location.lat, location.lng),
      status: 'unconfirmed',
      confidence: 0,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
      photo_path: images[0]?.path ?? null,
      food_servings: foodServings,
      food_type: foodType,
      safe_until: safeUntil,
      last_report_at: nowIso,
    }).select('id').single()
    if (error) throw new Error(`cluster insert failed: ${error.message}`)
    clusterId = (c as { id: string }).id
    createdCluster = true
  }

  // ---- 7. insert report
  const { data: rep, error: repErr } = await admin.from('reports').insert({
    reporter_id: user.id,
    client_id: body.client_id,
    cluster_id: clusterId,
    category: extraction.category,
    urgency,
    title_en: extraction.title_en,
    title_ur: extraction.title_ur,
    summary_en: extraction.summary_en,
    summary_ur: extraction.summary_ur,
    canonical_en: extraction.canonical_en,
    transcript: transcript || null,
    language: extraction.language || transcription?.language || null,
    input_modes: inputModes,
    embedding: vecLiteral,
    embedding_model: embedding?.model ?? null,
    location: pointWkt(location.lat, location.lng),
    location_source: location.source,
    address_text: body.address_text || null,
    location_hints: extraction.location_hints,
    status: 'unconfirmed',
    confidence: 0,
    is_spam: false,
    photo_check: photoCheck,
    extraction: {
      ...extraction,
      _pipeline: {
        similarity,
        is_duplicate: isDuplicate,
        match: matchMethod,
        same_incident_reason: sameReason,
        transcribe_model: transcription?.meta.model ?? null,
        extract_model: extractMeta?.model ?? null,
        extract_fallback: extractFallback || Boolean(extractMeta?.fallback),
        vision_model: (visionMeta as AiMeta | null)?.model ?? null,
        embed_model: embedding?.model ?? null,
        accuracy_m: body.accuracy_m,
        geocode: geocoded ? { label: (geocoded as GeocodeResult).label, source: (geocoded as GeocodeResult).source, query: (geocoded as GeocodeResult).query } : null,
        timings_ms: T.timings,
      },
    },
    ai_provider: aiProvider,
    food_servings: foodServings,
    food_type: foodType,
    safe_until: safeUntil,
  }).select('id').single()
  if (repErr) {
    if (createdCluster) await admin.from('clusters').delete().eq('id', clusterId)
    if (repErr.code === '23505') {
      const again = await findExisting(user.id, body.client_id)
      if (again) return json(await storedResult(again))
    }
    throw new Error(`report insert failed: ${repErr.message}`)
  }
  const reportId = (rep as { id: string }).id
  const cid = clusterId as string

  // ---- 8. media rows + cluster bookkeeping, then recompute aggregates
  await T.run('persist', async () => {
    const media = mediaRows(reportId)
    const [mRes, cRes] = await Promise.all([
      media.length ? admin.from('report_media').insert(media) : Promise.resolve({ error: null }),
      createdCluster
        ? admin.from('clusters').update({ primary_report_id: reportId }).eq('id', cid)
        : admin.from('clusters').update({ last_report_at: nowIso }).eq('id', cid),
    ])
    if (mRes.error) console.warn('[process-report] media insert failed', mRes.error.message)
    if (cRes.error) console.warn('[process-report] cluster bookkeeping failed', cRes.error.message)
    const { error } = await admin.rpc('recompute_cluster', { p_cluster_id: cid })
    if (error) console.error('[process-report] recompute_cluster failed', error.message)
  })

  // ---- 9. verify inline
  let v: Pick<VerifyResult, 'status' | 'confidence' | 'reason' | 'changed_to_verified'>
  try {
    v = await T.run('verify', () => verifyCluster(cid))
  } catch (e) {
    console.error('[process-report] verify failed:', errMsg(e))
    const { data } = await admin.from('clusters').select('status, confidence, ai_reason').eq('id', cid).maybeSingle()
    const c = data as { status: ReportStatus; confidence: number; ai_reason: string | null } | null
    v = { status: c?.status ?? 'unconfirmed', confidence: c?.confidence ?? 0, reason: c?.ai_reason ?? '', changed_to_verified: false }
  }

  // ---- 10. route inline (verified or high/critical) + nearby alerts / reporter updates in background
  const routed = await T.run('route', () => escalateCluster(cid, v, { excludeReporterIds: [user.id] }))

  // keep the reporter's last location fresh for nearby alerts (GPS only)
  if (body.point && body.location_source === 'gps') {
    const p = body.point
    background((async () => {
      const { error } = await admin.from('profiles').update({
        last_location: pointWkt(p.lat, p.lng),
        last_location_at: nowIso,
      }).eq('id', user.id)
      if (error) console.warn('[process-report] last_location update failed', error.message)
    })())
  }

  const res: ProcessReportResponse & { location: { lat: number; lng: number; source: string; label?: string } } = {
    report_id: reportId,
    cluster_id: cid,
    is_duplicate: isDuplicate,
    similarity,
    status: v.status,
    confidence: v.confidence,
    category: extraction.category,
    urgency,
    title_en: extraction.title_en,
    title_ur: extraction.title_ur,
    summary_en: extraction.summary_en,
    summary_ur: extraction.summary_ur,
    ai_reason: v.reason || null,
    routed: routed.map(publicRouted),
    ai_provider: aiProvider,
    transcript: transcriptOut,
    food: isFood && safeUntil ? { servings: foodServings ?? 0, safe_until: safeUntil, food_type: foodType ?? '' } : null,
    location: {
      lat: location.lat,
      lng: location.lng,
      source: location.source,
      ...(geocoded ? { label: (geocoded as GeocodeResult).label } : {}),
    },
  }
  console.log(JSON.stringify({
    fn: 'process-report', client_id: body.client_id, report_id: reportId, cluster_id: cid, match: matchMethod,
    similarity, status: v.status, confidence: v.confidence, routed: routed.length, modes: inputModes,
    timings_ms: T.timings, total_ms: T.total(),
  }))
  return json(res)
})
