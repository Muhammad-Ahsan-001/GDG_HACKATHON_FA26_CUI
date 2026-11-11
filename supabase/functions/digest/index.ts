// POST {mode:'nearby', lat, lng, radius_m?} | {mode:'daily', org_id?}
//   -> {en, ur, provider, generated_at, pin_count, ai}
// nearby: open map pins around a point (no sign-in needed). daily: last 24 h — the caller's org assignments when
// org_id is given and the caller owns it (or is admin), otherwise every pin active in the last 24 h.
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { adminClient, requireUser } from '../_shared/supabase.ts'
import { digest } from '../_shared/ai.ts'
import type { DigestPin, Provider } from '../_shared/types.ts'

const DEFAULT_RADIUS_M = 3000
const MAX_RADIUS_M = 20000
const MAX_PINS = 25
const DAY_MS = 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 5 * 60 * 1000

interface DigestBody { mode?: unknown; lat?: unknown; lng?: unknown; radius_m?: unknown; org_id?: unknown }

interface PinRow extends DigestPin {
  id: string
  title_ur: string
  version: string
}

interface DigestResult { en: string; ur: string; provider: Provider; generated_at: string; pin_count: number; ai: boolean }

const URGENCY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }

const CATEGORY_LABEL: Record<string, { en: string; ur: string }> = {
  hazard: { en: 'hazard', ur: 'خطرہ' },
  fire: { en: 'fire', ur: 'آگ' },
  flood: { en: 'flooding', ur: 'سیلابی پانی' },
  water: { en: 'water', ur: 'پانی' },
  food: { en: 'food', ur: 'کھانا' },
  health: { en: 'health', ur: 'صحت' },
  safety: { en: 'safety', ur: 'تحفظ' },
  other: { en: 'other', ur: 'دیگر' },
}

const URGENCY_UR: Record<string, string> = { critical: 'انتہائی فوری', high: 'فوری', medium: 'درمیانہ', low: 'کم' }

// Per-isolate cache so repeated opens of the same area don't re-bill the model.
const cache = new Map<string, { at: number; result: DigestResult }>()

function cacheGet(key: string): DigestResult | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.result
}

function cachePut(key: string, result: DigestResult): void {
  if (cache.size >= 200) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), result })
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function minutesSince(iso: string | null | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : 0
}

function sortPins<T extends DigestPin>(pins: T[]): T[] {
  return pins.sort((a, b) => (URGENCY_RANK[b.urgency] ?? 0) - (URGENCY_RANK[a.urgency] ?? 0) || a.minutes_ago - b.minutes_ago)
}

function toDigestPin(p: PinRow): DigestPin {
  const out: DigestPin = {
    category: p.category,
    urgency: p.urgency,
    status: p.status,
    title_en: p.title_en,
    report_count: p.report_count,
    minutes_ago: p.minutes_ago,
  }
  if (typeof p.distance_m === 'number') out.distance_m = p.distance_m
  return out
}

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`
}

function fmtDistanceUr(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} کلومیٹر` : `${Math.max(10, Math.round(m / 10) * 10)} میٹر`
}

function quietMessage(mode: 'nearby' | 'daily', radiusM: number, orgName?: string): { en: string; ur: string } {
  if (mode === 'nearby') {
    const km = Number((radiusM / 1000).toFixed(1))
    return {
      en: `All quiet near you. No open reports within ${km} km right now. If you see a problem, tap the mic and tell us.`,
      ur: `آپ کے قریب سب خیریت ہے۔ ${km} کلومیٹر کے اندر اس وقت کوئی کھلی رپورٹ نہیں۔ کوئی مسئلہ نظر آئے تو مائیک دبائیں اور ہمیں بتائیں۔`,
    }
  }
  if (orgName) {
    return {
      en: `Quiet day for ${orgName}: no alerts in the last 24 hours. Keep notifications on so new alerts reach you fast.`,
      ur: `${orgName} کے لیے پچھلے 24 گھنٹوں میں کوئی الرٹ نہیں آیا۔ نوٹیفکیشن آن رکھیں تاکہ نئے الرٹ فوراً ملیں۔`,
    }
  }
  return {
    en: 'A quiet 24 hours: no new reports across Islamabad and Rawalpindi. Stay alert and report anything you see.',
    ur: 'پچھلے 24 گھنٹوں میں اسلام آباد اور راولپنڈی میں کوئی نئی رپورٹ نہیں آئی۔ ہوشیار رہیں اور جو نظر آئے رپورٹ کریں۔',
  }
}

/** Deterministic bilingual summary used only if both AI models fail, so the UI never breaks. */
function templateSummary(mode: 'nearby' | 'daily', pins: PinRow[], orgName?: string): { en: string; ur: string } {
  const counts = new Map<string, number>()
  for (const p of pins) counts.set(p.category, (counts.get(p.category) ?? 0) + 1)
  const countEn = [...counts].map(([c, n]) => `${n} ${CATEGORY_LABEL[c]?.en ?? c}`).join(', ')
  const countUr = [...counts].map(([c, n]) => `${CATEGORY_LABEL[c]?.ur ?? c} ${n}`).join('، ')
  const top = pins[0]
  const whereEn = mode === 'nearby' ? 'near you' : orgName ? `for ${orgName} in the last 24 hours` : 'in the last 24 hours'
  const whereUr = mode === 'nearby' ? 'آپ کے قریب' : orgName ? `پچھلے 24 گھنٹوں میں ${orgName} کے لیے` : 'پچھلے 24 گھنٹوں میں'
  const distEn = typeof top.distance_m === 'number' ? `, ${fmtDistance(top.distance_m)} away` : ''
  const distUr = typeof top.distance_m === 'number' ? `، ${fmtDistanceUr(top.distance_m)} دور` : ''
  return {
    en: `${pins.length} issue${pins.length === 1 ? '' : 's'} ${whereEn}: ${countEn}. Most urgent: ${top.title_en} (${top.urgency}${distEn}). Stay safe and call 1122 in an emergency.`,
    ur: `${whereUr} ${pins.length} مسائل: ${countUr}۔ سب سے اہم: ${top.title_ur || top.title_en} (${URGENCY_UR[top.urgency] ?? top.urgency}${distUr})۔ محفوظ رہیں، ایمرجنسی میں 1122 پر کال کریں۔`,
  }
}

async function summarise(
  cacheKey: string,
  mode: 'nearby' | 'daily',
  pins: PinRow[],
  radiusM: number,
  orgName?: string,
): Promise<DigestResult> {
  const fingerprint = pins.map((p) => `${p.id}:${p.version}:${p.status}`).join('|')
  const key = `${cacheKey}|${fingerprint}`
  const hit = cacheGet(key)
  if (hit) return hit

  const generated_at = new Date().toISOString()
  let result: DigestResult
  if (!pins.length) {
    result = { ...quietMessage(mode, radiusM, orgName), provider: 'openai', generated_at, pin_count: 0, ai: false }
  } else {
    try {
      const out = await digest({ pins: pins.map(toDigestPin), mode, orgName })
      result = { en: out.en, ur: out.ur, provider: out.meta.provider, generated_at, pin_count: pins.length, ai: true }
    } catch (e) {
      console.error('[digest] AI failed, using template', e instanceof Error ? e.message : e)
      return { ...templateSummary(mode, pins, orgName), provider: 'openai', generated_at, pin_count: pins.length, ai: false }
    }
  }
  cachePut(key, result)
  return result
}

interface MapPinRow {
  id: string
  category: string
  urgency: string
  status: string
  lat: number
  lng: number
  report_count: number | null
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  created_at: string | null
  updated_at: string | null
  last_report_at: string | null
}

const PIN_COLUMNS = 'id, category, urgency, status, lat, lng, report_count, title_en, title_ur, summary_en, created_at, updated_at, last_report_at'

function pinFromMapRow(r: MapPinRow, now: number, distance?: number): PinRow {
  const pin: PinRow = {
    id: r.id,
    category: r.category,
    urgency: r.urgency,
    status: r.status,
    title_en: r.title_en || r.summary_en || `${r.category} report`,
    title_ur: r.title_ur || '',
    report_count: r.report_count ?? 1,
    minutes_ago: minutesSince(r.last_report_at ?? r.created_at, now),
    version: r.updated_at ?? r.last_report_at ?? '',
  }
  if (distance !== undefined) pin.distance_m = Math.round(distance)
  return pin
}

async function nearby(body: DigestBody): Promise<DigestResult> {
  const lat = Number(body.lat)
  const lng = Number(body.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'lat and lng are required numbers', 'bad_location')
  }
  const r = Number(body.radius_m)
  const radius = Number.isFinite(r) && r > 0 ? Math.min(Math.max(r, 100), MAX_RADIUS_M) : DEFAULT_RADIUS_M
  const dLat = radius / 111320
  const dLng = radius / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))

  const { data, error } = await adminClient()
    .from('map_pins')
    .select(PIN_COLUMNS)
    .gte('lat', lat - dLat)
    .lte('lat', lat + dLat)
    .gte('lng', lng - dLng)
    .lte('lng', lng + dLng)
    .neq('status', 'resolved')
    .order('last_report_at', { ascending: false })
    .limit(500)
  if (error) throw new HttpError(500, `Could not read map pins: ${error.message}`, 'db_error')

  const now = Date.now()
  const pins: PinRow[] = []
  for (const row of (data ?? []) as MapPinRow[]) {
    const d = haversineM(lat, lng, Number(row.lat), Number(row.lng))
    if (d <= radius) pins.push(pinFromMapRow(row, now, d))
  }
  const top = sortPins(pins).slice(0, MAX_PINS)
  const key = `nearby|${lat.toFixed(3)}|${lng.toFixed(3)}|${Math.round(radius)}`
  return await summarise(key, 'nearby', top, radius)
}

interface AssignmentRow {
  cluster_id: string
  status: string
  distance_m: number | null
  alerted_at: string | null
  resolved_at: string | null
}

interface ClusterRow {
  id: string
  category: string
  urgency: string
  status: string
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  report_count: number | null
  created_at: string | null
  updated_at: string | null
  last_report_at: string | null
}

async function orgPins(orgId: string, now: number): Promise<PinRow[]> {
  const admin = adminClient()
  const since = now - DAY_MS
  const { data: asg, error } = await admin
    .from('assignments')
    .select('cluster_id, status, distance_m, alerted_at, resolved_at')
    .eq('org_id', orgId)
    .order('alerted_at', { ascending: false })
    .limit(300)
  if (error) throw new HttpError(500, `Could not read assignments: ${error.message}`, 'db_error')
  // last 24 h of alerts, plus anything still open (needs action), plus anything resolved today
  const relevant = ((asg ?? []) as AssignmentRow[]).filter((a) =>
    a.status !== 'resolved' ||
    Date.parse(a.alerted_at ?? '') >= since ||
    Date.parse(a.resolved_at ?? '') >= since
  )
  if (!relevant.length) return []

  const ids = [...new Set(relevant.map((a) => a.cluster_id))]
  const { data: clusters, error: cErr } = await admin
    .from('clusters')
    .select('id, category, urgency, status, title_en, title_ur, summary_en, report_count, created_at, updated_at, last_report_at')
    .in('id', ids)
  if (cErr) throw new HttpError(500, `Could not read clusters: ${cErr.message}`, 'db_error')
  const byId = new Map(((clusters ?? []) as ClusterRow[]).map((c) => [c.id, c]))

  const pins: PinRow[] = []
  for (const a of relevant) {
    const c = byId.get(a.cluster_id)
    if (!c) continue
    const pin: PinRow = {
      id: c.id,
      category: c.category,
      urgency: c.urgency,
      status: a.status, // the team's assignment status: alerted | claimed | in_progress | resolved
      title_en: c.title_en || c.summary_en || `${c.category} report`,
      title_ur: c.title_ur || '',
      report_count: c.report_count ?? 1,
      minutes_ago: minutesSince(c.last_report_at ?? a.alerted_at ?? c.created_at, now),
      version: `${c.updated_at ?? ''}/${a.status}`,
    }
    if (typeof a.distance_m === 'number') pin.distance_m = Math.round(a.distance_m)
    pins.push(pin)
  }
  return pins
}

async function cityPins(now: number): Promise<PinRow[]> {
  const since = new Date(now - DAY_MS).toISOString()
  const { data, error } = await adminClient()
    .from('map_pins')
    .select(PIN_COLUMNS)
    .gte('updated_at', since)
    .order('last_report_at', { ascending: false })
    .limit(500)
  if (error) throw new HttpError(500, `Could not read map pins: ${error.message}`, 'db_error')
  return ((data ?? []) as MapPinRow[]).map((r) => pinFromMapRow(r, now))
}

async function daily(req: Request, body: DigestBody): Promise<DigestResult> {
  const user = await requireUser(req)
  const now = Date.now()
  const orgId = typeof body.org_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.org_id) ? body.org_id : null

  let orgName: string | undefined
  let pins: PinRow[] | null = null
  if (orgId) {
    const admin = adminClient()
    const { data: org } = await admin.from('organizations').select('id, name, owner_id').eq('id', orgId).maybeSingle()
    if (org) {
      let allowed = org.owner_id === user.id
      if (!allowed) {
        const { data: prof } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
        allowed = prof?.role === 'admin'
      }
      if (allowed) {
        orgName = org.name ?? undefined
        pins = await orgPins(org.id, now)
      }
    }
  }
  if (!pins) pins = await cityPins(now)

  const top = sortPins(pins).slice(0, MAX_PINS)
  const key = `daily|${orgName ? orgId : 'city'}`
  return await summarise(key, 'daily', top, 0, orgName)
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const body = await readJson<DigestBody>(req)
  if (body?.mode === 'nearby') return json(await nearby(body))
  if (body?.mode === 'daily') return json(await daily(req, body))
  throw new HttpError(400, "mode must be 'nearby' or 'daily'", 'bad_mode')
})
