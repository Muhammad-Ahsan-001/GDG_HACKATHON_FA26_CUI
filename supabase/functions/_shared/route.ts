// Responder routing: find the right organisations for a cluster (find_responders), create assignments
// (idempotent on cluster_id + org_id), notify org owners in-app + FCM, stamp clusters.routed_at.
// escalateCluster() is the shared "after verification" step used by process-report, vote and verify-report.
// routeToPolice() is the SOS path (docs/CONTRACT-1B.md §SOS): private safety cluster -> nearby police only,
// regardless of verification, notification type 'sos_alert'. Private clusters never go through the normal routing.
import { ROUTE_MAX_ORGS } from './config.ts'
import { parsePoint } from './geocode.ts'
import { background, HttpError } from './http.ts'
import {
  type BilingualMessage,
  categoryLabel,
  type NotificationType,
  notifyNearby,
  notifyReporters,
  notifyUsers,
  type NotifyResult,
  urgencyLabel,
} from './notify.ts'
import { adminClient } from './supabase.ts'
import type { ReportStatus, RoutedOrg, Urgency } from './types.ts'
import type { VerifyResult } from './verify.ts'

const HIGH: Urgency[] = ['high', 'critical']

/** SOS notification types (notifications.type is free text; notify.ts's union predates SOS). */
export const SOS_ALERT = 'sos_alert' as string as NotificationType
export const SOS_LOGGED = 'sos_logged' as string as NotificationType

interface ClusterRow {
  id: string
  category: string
  urgency: Urgency
  status: ReportStatus
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  centroid: unknown
  primary_report_id: string | null
  report_count: number | null
  confidence: number | null
  food_servings: number | null
  food_type: string | null
  safe_until: string | null
  routed_at: string | null
  nearby_notified_at: string | null
  is_private: boolean | null
  sos_session_id: string | null
}

const CLUSTER_COLS = 'id, category, urgency, status, title_en, title_ur, summary_en, summary_ur, centroid, ' +
  'primary_report_id, report_count, confidence, food_servings, food_type, safe_until, routed_at, nearby_notified_at, ' +
  'is_private, sos_session_id'

async function loadCluster(clusterId: string): Promise<ClusterRow> {
  const { data, error } = await adminClient().from('clusters').select(CLUSTER_COLS).eq('id', clusterId).maybeSingle()
  if (error) throw new Error(`route: cluster lookup failed: ${error.message}`)
  if (!data) throw new HttpError(404, 'Cluster not found', 'not_found')
  return data as unknown as ClusterRow
}

/** Should this cluster be routed to responders now? (verified, or high/critical routed early) */
/** Route when verified, when high/critical (early, labelled unconfirmed), or always for food rescue (time-critical). */
export function shouldRoute(status: ReportStatus, urgency: Urgency, category?: string | null): boolean {
  if (status === 'resolved') return false
  return status === 'verified' || HIGH.includes(urgency) || category === 'food'
}

function km(m: number | null | undefined): { en: string; ur: string } {
  if (m == null || !Number.isFinite(m)) return { en: '', ur: '' }
  const v = m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
  const u = m < 1000 ? `${Math.round(m)} میٹر` : `${(m / 1000).toFixed(1)} کلومیٹر`
  return { en: v, ur: u }
}

function pkTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso.slice(11, 16)
  }
}

function orgAlertMessage(c: ClusterRow, distance_m: number | null): BilingualMessage {
  const cat = categoryLabel(c.category)
  const urg = urgencyLabel(c.urgency)
  const d = km(distance_m)
  const unconfirmed = c.status !== 'verified' && c.status !== 'in_progress'
  const titleEn = c.title_en ?? cat.en
  const titleUr = c.title_ur ?? cat.ur
  const n = c.report_count ?? 1
  const pct = Math.round((c.confidence ?? 0) * 100)
  if (c.category === 'food' && !c.food_servings && !c.food_type && !c.safe_until) {
    // food NEED (hunger), not surplus food on offer
    return {
      title_en: `${unconfirmed ? 'UNCONFIRMED — routed early · ' : ''}Food needed: ${titleEn}`,
      title_ur: `${unconfirmed ? 'غیر تصدیق شدہ — جلد بھیجا گیا · ' : ''}کھانے کی ضرورت: ${titleUr}`,
      body_en: [c.summary_en ?? titleEn, `${n} report${n === 1 ? '' : 's'}`, d.en ? `${d.en} from you` : '']
        .filter(Boolean).join(' · '),
      body_ur: [c.summary_ur ?? titleUr, `${n} رپورٹس`, d.ur ? `آپ سے ${d.ur}` : ''].filter(Boolean).join(' · '),
    }
  }
  if (c.category === 'food') {
    const servings = c.food_servings ? `~${c.food_servings} servings` : 'servings unknown'
    const servingsUr = c.food_servings ? `تقریباً ${c.food_servings} افراد کا` : ''
    const until = pkTime(c.safe_until)
    return {
      title_en: `${unconfirmed ? 'UNCONFIRMED — routed early · ' : ''}Surplus food: ${c.food_type ?? titleEn}, ${servings}`,
      title_ur: `${unconfirmed ? 'غیر تصدیق شدہ — جلد بھیجا گیا · ' : ''}اضافی کھانا: ${titleUr}`,
      body_en: [c.summary_en ?? titleEn, until ? `Safe until ${until}` : '', d.en ? `${d.en} from you` : '']
        .filter(Boolean).join(' · '),
      body_ur: [c.summary_ur ?? titleUr, servingsUr ? `${servingsUr} کھانا` : '', until ? `${until} تک محفوظ` : '',
        d.ur ? `آپ سے ${d.ur}` : ''].filter(Boolean).join(' · '),
    }
  }
  return {
    title_en: `${unconfirmed ? 'UNCONFIRMED — routed early · ' : ''}${urg.en} ${cat.en.toLowerCase()}: ${titleEn}`,
    title_ur: `${unconfirmed ? 'غیر تصدیق شدہ — جلد بھیجا گیا · ' : ''}${cat.ur} (${urg.ur}): ${titleUr}`,
    body_en: [
      c.summary_en ?? titleEn,
      `${n} report${n === 1 ? '' : 's'}`,
      unconfirmed ? 'not yet verified' : `verified ${pct}%`,
      d.en ? `${d.en} from you` : '',
    ].filter(Boolean).join(' · '),
    body_ur: [
      c.summary_ur ?? titleUr,
      `${n} رپورٹس`,
      unconfirmed ? 'ابھی تصدیق نہیں ہوئی' : `تصدیق ${pct}%`,
      d.ur ? `آپ سے ${d.ur}` : '',
    ].filter(Boolean).join(' · '),
  }
}

function verifiedUpdateMessage(c: ClusterRow): BilingualMessage {
  const cat = categoryLabel(c.category)
  const pct = Math.round((c.confidence ?? 0) * 100)
  const n = c.report_count ?? 1
  return {
    title_en: `Now verified: ${c.title_en ?? cat.en}`,
    title_ur: `اب تصدیق شدہ: ${c.title_ur ?? cat.ur}`,
    body_en: `${n} reports, confidence ${pct}%. Please act on this alert.`,
    body_ur: `${n} رپورٹس، اعتماد ${pct}%۔ براہ کرم اس اطلاع پر کارروائی کریں۔`,
  }
}

interface OrgInfo { id: string; name: string; org_type: string; owner_id: string }

async function orgsById(ids: string[]): Promise<Map<string, OrgInfo>> {
  const map = new Map<string, OrgInfo>()
  if (!ids.length) return map
  const { data, error } = await adminClient().from('organizations').select('id, name, org_type, owner_id').in('id', ids)
  if (error) console.warn('[route] organizations lookup failed', error.message)
  for (const o of (data ?? []) as OrgInfo[]) map.set(o.id, o)
  return map
}

/** Organisations already alerted for a cluster (no side effects). */
export async function listRouted(clusterId: string): Promise<RoutedOrg[]> {
  const { data, error } = await adminClient().from('assignments').select('org_id, distance_m')
    .eq('cluster_id', clusterId).order('distance_m', { ascending: true })
  if (error) {
    console.warn('[route] assignments lookup failed', error.message)
    return []
  }
  const rows = (data ?? []) as { org_id: string; distance_m: number | null }[]
  const orgs = await orgsById(rows.map((r) => r.org_id))
  return rows.map((r) => ({
    org_id: r.org_id,
    org_name: orgs.get(r.org_id)?.name ?? '',
    org_type: orgs.get(r.org_id)?.org_type ?? '',
    distance_m: Math.round(r.distance_m ?? 0),
    pushed: 0,
  }))
}

/**
 * Route a cluster to up to ROUTE_MAX_ORGS responders. Organisations that already have an assignment for the
 * cluster are not re-alerted (unless `verifiedNow`, which sends them a "now verified" update instead).
 * Returns every organisation routed for the cluster (existing + new); `pushed` = device tokens targeted.
 */
export async function routeCluster(clusterId: string, opts: { verifiedNow?: boolean } = {}): Promise<RoutedOrg[]> {
  const t0 = performance.now()
  const admin = adminClient()
  const c = await loadCluster(clusterId)
  if (c.status === 'resolved') return await listRouted(clusterId)
  // private (SOS) clusters are routed to police only, by routeToPolice()
  if (c.is_private) return await listRouted(clusterId)
  const point = parsePoint(c.centroid)
  if (!point) {
    console.warn('[route] cluster has no parseable centroid', clusterId)
    return await listRouted(clusterId)
  }

  const [respRes, existingRes] = await Promise.all([
    admin.rpc('find_responders', { p_lat: point.lat, p_lng: point.lng, p_category: c.category, p_limit: ROUTE_MAX_ORGS }),
    admin.from('assignments').select('id, org_id, status, distance_m').eq('cluster_id', clusterId),
  ])
  if (respRes.error) console.error('[route] find_responders failed', respRes.error.message)
  if (existingRes.error) console.error('[route] assignments lookup failed', existingRes.error.message)
  const responders = ((respRes.data ?? []) as {
    org_id: string; org_name: string; org_type: string; owner_id: string; distance_m: number
  }[]).slice(0, ROUTE_MAX_ORGS)
  const existing = (existingRes.data ?? []) as { id: string; org_id: string; status: string; distance_m: number | null }[]
  const existingIds = new Set(existing.map((a) => a.org_id))

  // ---- new assignments (ignore duplicates: a concurrent router may have inserted the same pair)
  const toInsert = responders.filter((r) => !existingIds.has(r.org_id))
  let inserted: { id: string; org_id: string; distance_m: number | null }[] = []
  if (toInsert.length) {
    const { data, error } = await admin.from('assignments')
      .upsert(
        toInsert.map((r) => ({
          cluster_id: clusterId,
          report_id: c.primary_report_id,
          org_id: r.org_id,
          status: 'alerted',
          distance_m: Math.round(r.distance_m ?? 0),
        })),
        { onConflict: 'cluster_id,org_id', ignoreDuplicates: true },
      )
      .select('id, org_id, distance_m')
    if (error) console.error('[route] assignments upsert failed', error.message)
    inserted = (data ?? []) as typeof inserted
  }

  const orgInfo = await orgsById([...new Set([...existing.map((a) => a.org_id), ...inserted.map((a) => a.org_id)])])
  for (const r of responders) {
    if (!orgInfo.has(r.org_id)) orgInfo.set(r.org_id, { id: r.org_id, name: r.org_name, org_type: r.org_type, owner_id: r.owner_id })
  }

  const pushedByOrg = new Map<string, number>()
  const type = c.category === 'food' ? 'food_alert' : 'new_assignment'
  await Promise.all(inserted.map(async (a) => {
    const org = orgInfo.get(a.org_id)
    if (!org?.owner_id) return
    const res = await notifyUsers([org.owner_id], type, orgAlertMessage(c, a.distance_m), {
      cluster_id: clusterId,
      report_id: c.primary_report_id,
      url: '/dashboard',
      data: { assignment_id: a.id, org_id: a.org_id, category: c.category, urgency: c.urgency, status: c.status },
    })
    pushedByOrg.set(a.org_id, res.tokens)
  }))

  // ---- orgs alerted earlier (while unconfirmed) hear that it is now verified
  if (opts.verifiedNow) {
    const insertedIds = new Set(inserted.map((a) => a.org_id))
    const earlier = existing.filter((a) => !insertedIds.has(a.org_id) && a.status !== 'resolved')
    const msg = verifiedUpdateMessage(c)
    await Promise.all(earlier.map(async (a) => {
      const org = orgInfo.get(a.org_id)
      if (!org?.owner_id) return
      const res = await notifyUsers([org.owner_id], 'verified', msg, {
        cluster_id: clusterId,
        report_id: c.primary_report_id,
        url: '/dashboard',
        data: { assignment_id: a.id, org_id: a.org_id, category: c.category, urgency: c.urgency, status: 'verified' },
      })
      pushedByOrg.set(a.org_id, res.tokens)
    }))
  }

  if (inserted.length && !c.routed_at) {
    const { error } = await admin.from('clusters').update({ routed_at: new Date().toISOString() })
      .eq('id', clusterId).is('routed_at', null)
    if (error) console.warn('[route] routed_at update failed', error.message)
  }

  const all = [
    ...existing.map((a) => ({ org_id: a.org_id, distance_m: a.distance_m })),
    ...inserted.filter((a) => !existingIds.has(a.org_id)).map((a) => ({ org_id: a.org_id, distance_m: a.distance_m })),
  ]
  const result: RoutedOrg[] = all
    .map((a) => ({
      org_id: a.org_id,
      org_name: orgInfo.get(a.org_id)?.name ?? '',
      org_type: orgInfo.get(a.org_id)?.org_type ?? '',
      distance_m: Math.round(a.distance_m ?? 0),
      pushed: pushedByOrg.get(a.org_id) ?? 0,
    }))
    .sort((x, y) => x.distance_m - y.distance_m)
  console.log(JSON.stringify({
    fn: 'route', cluster_id: clusterId, candidates: responders.length, existing: existing.length,
    inserted: inserted.length, verified_now: Boolean(opts.verifiedNow), ms: Math.round(performance.now() - t0),
  }))
  return result
}

/**
 * After a verification: route when (verified OR high/critical), alert nearby citizens (background) when verified +
 * high/critical and not yet alerted, and tell the cluster's reporters (background) when it just became verified.
 * Returns the organisations routed for the cluster. Never throws (logs and returns what it can).
 */
export async function escalateCluster(
  clusterId: string,
  v: Pick<VerifyResult, 'status' | 'changed_to_verified'>,
  opts: { excludeReporterIds?: string[] } = {},
): Promise<RoutedOrg[]> {
  try {
    const { data } = await adminClient().from('clusters').select('urgency, status, category, nearby_notified_at, is_private')
      .eq('id', clusterId).maybeSingle()
    // private (SOS) clusters: no public routing, no nearby alerts, no "verified" broadcasts
    if ((data as { is_private?: boolean } | null)?.is_private) return await listRouted(clusterId)
    const urgency = ((data as { urgency?: Urgency } | null)?.urgency ?? 'medium') as Urgency
    const status = ((data as { status?: ReportStatus } | null)?.status ?? v.status) as ReportStatus
    const nearbyDone = Boolean((data as { nearby_notified_at?: string | null } | null)?.nearby_notified_at)
    const category = (data as { category?: string } | null)?.category ?? null

    const routed = shouldRoute(status, urgency, category)
      ? await routeCluster(clusterId, { verifiedNow: v.changed_to_verified })
      : await listRouted(clusterId)

    if (status === 'verified' && HIGH.includes(urgency) && !nearbyDone) background(notifyNearby(clusterId))

    if (v.changed_to_verified) {
      const alerted = routed.length > 0
      background(notifyReporters(clusterId, 'verified', {
        title_en: 'Your report is verified',
        title_ur: 'آپ کی رپورٹ کی تصدیق ہو گئی',
        body_en: alerted
          ? 'Other people confirmed it too. Responders have been alerted.'
          : 'Other people confirmed it too. Thank you for speaking up.',
        body_ur: alerted
          ? 'دوسرے لوگوں نے بھی تصدیق کی۔ متعلقہ اداروں کو اطلاع دے دی گئی ہے۔'
          : 'دوسرے لوگوں نے بھی تصدیق کی۔ آواز اٹھانے کا شکریہ۔',
      }, { excludeUserIds: opts.excludeReporterIds, data: { status: 'verified' } }))
    }
    return routed
  } catch (e) {
    console.error('[route] escalateCluster failed', e instanceof Error ? e.message : e)
    return await listRouted(clusterId).catch(() => [])
  }
}

// ======================================================================= SOS (women's safety)

export interface SosAlertText { title_en: string; title_ur: string; body_en: string; body_ur: string }

interface ResponderRow { org_id: string; org_name: string; org_type: string; owner_id: string; distance_m: number }

/**
 * SOS: alert nearby POLICE for a private safety cluster, regardless of its status / verification.
 * find_responders(category 'safety') -> police orgs first (other approved safety responders only when no police
 * org covers the point) -> assignments (idempotent on cluster_id + org_id) -> notifications type 'sos_alert' for
 * the org owners (awaited, so realtime fires now) + FCM push in the background -> clusters.routed_at.
 * Orgs already alerted for the cluster are not re-notified (use notifyPolice() for follow-up updates).
 * Returns every organisation routed for the cluster (existing + new); `pushed` = device tokens targeted.
 */
export async function routeToPolice(
  clusterId: string,
  opts: { title_en: string; title_ur: string; body_en: string; body_ur: string },
): Promise<RoutedOrg[]> {
  const t0 = performance.now()
  const admin = adminClient()
  const c = await loadCluster(clusterId)
  const point = parsePoint(c.centroid)
  if (!point) {
    console.error('[route] SOS cluster has no parseable centroid', clusterId)
    return await listRouted(clusterId)
  }

  const [respRes, existingRes] = await Promise.all([
    admin.rpc('find_responders', { p_lat: point.lat, p_lng: point.lng, p_category: 'safety', p_limit: 10 }),
    admin.from('assignments').select('id, org_id, status, distance_m').eq('cluster_id', clusterId),
  ])
  if (respRes.error) console.error('[route] SOS find_responders failed', respRes.error.message)
  if (existingRes.error) console.error('[route] SOS assignments lookup failed', existingRes.error.message)
  const candidates = (respRes.data ?? []) as ResponderRow[]
  const police = candidates.filter((r) => r.org_type === 'police')
  if (!police.length && candidates.length) {
    console.warn('[route] SOS: no police org covers the point; alerting other approved safety responders', clusterId)
  }
  if (!candidates.length) console.error('[route] SOS: NO safety responder covers', clusterId, point)
  const responders = (police.length ? police : candidates).slice(0, ROUTE_MAX_ORGS)
  const existing = (existingRes.data ?? []) as { id: string; org_id: string; status: string; distance_m: number | null }[]
  const existingIds = new Set(existing.map((a) => a.org_id))

  const toInsert = responders.filter((r) => !existingIds.has(r.org_id))
  let inserted: { id: string; org_id: string; distance_m: number | null }[] = []
  if (toInsert.length) {
    const { data, error } = await admin.from('assignments')
      .upsert(
        toInsert.map((r) => ({
          cluster_id: clusterId,
          report_id: c.primary_report_id,
          org_id: r.org_id,
          status: 'alerted',
          distance_m: Math.round(r.distance_m ?? 0),
          note: 'SOS alert',
        })),
        { onConflict: 'cluster_id,org_id', ignoreDuplicates: true },
      )
      .select('id, org_id, distance_m')
    if (error) console.error('[route] SOS assignments upsert failed', error.message)
    inserted = (data ?? []) as typeof inserted
  }

  const orgInfo = await orgsById([...new Set([...existing.map((a) => a.org_id), ...inserted.map((a) => a.org_id)])])
  for (const r of responders) {
    if (!orgInfo.has(r.org_id)) orgInfo.set(r.org_id, { id: r.org_id, name: r.org_name, org_type: r.org_type, owner_id: r.owner_id })
  }

  const pushedByOrg = new Map<string, number>()
  await Promise.all(inserted.map(async (a) => {
    const org = orgInfo.get(a.org_id)
    if (!org?.owner_id) return
    const d = km(a.distance_m)
    const msg: BilingualMessage = {
      title_en: opts.title_en,
      title_ur: opts.title_ur,
      body_en: [opts.body_en, d.en ? `${d.en} from you` : ''].filter(Boolean).join(' · '),
      body_ur: [opts.body_ur, d.ur ? `آپ سے ${d.ur}` : ''].filter(Boolean).join(' · '),
    }
    const res = await notifyUsers([org.owner_id], SOS_ALERT, msg, {
      cluster_id: clusterId,
      report_id: c.primary_report_id,
      url: '/dashboard',
      data: {
        assignment_id: a.id, org_id: a.org_id, category: 'safety', urgency: 'critical', status: c.status,
        sos: true, sos_session_id: c.sos_session_id,
      },
    })
    pushedByOrg.set(a.org_id, res.tokens)
  }))

  if (inserted.length && !c.routed_at) {
    const { error } = await admin.from('clusters').update({ routed_at: new Date().toISOString() })
      .eq('id', clusterId).is('routed_at', null)
    if (error) console.warn('[route] SOS routed_at update failed', error.message)
  }

  const all = [
    ...existing.map((a) => ({ org_id: a.org_id, distance_m: a.distance_m })),
    ...inserted.filter((a) => !existingIds.has(a.org_id)).map((a) => ({ org_id: a.org_id, distance_m: a.distance_m })),
  ]
  const result: RoutedOrg[] = all
    .map((a) => ({
      org_id: a.org_id,
      org_name: orgInfo.get(a.org_id)?.name ?? '',
      org_type: orgInfo.get(a.org_id)?.org_type ?? '',
      distance_m: Math.round(a.distance_m ?? 0),
      pushed: pushedByOrg.get(a.org_id) ?? 0,
    }))
    .sort((x, y) => x.distance_m - y.distance_m)
  console.log(JSON.stringify({
    fn: 'route_sos', cluster_id: clusterId, candidates: candidates.length, police: police.length, existing: existing.length,
    inserted: inserted.length, ms: Math.round(performance.now() - t0),
  }))
  return result
}

/**
 * Follow-up message to every organisation alerted for a (SOS) cluster, e.g. "User marked themselves safe" or
 * "live location updated". Default type 'sos_alert', link /dashboard. Never throws.
 */
export async function notifyPolice(
  clusterId: string,
  msg: SosAlertText,
  opts: { type?: string; data?: Record<string, string | number | boolean | null | undefined>; includeResolved?: boolean } = {},
): Promise<NotifyResult> {
  try {
    const { data, error } = await adminClient().from('assignments').select('org_id, status').eq('cluster_id', clusterId)
    if (error) {
      console.warn('[route] notifyPolice assignments lookup failed', error.message)
      return { notified: 0, tokens: 0 }
    }
    const rows = ((data ?? []) as { org_id: string; status: string }[])
      .filter((a) => opts.includeResolved || a.status !== 'resolved')
    const orgs = await orgsById([...new Set(rows.map((a) => a.org_id))])
    const owners = [...orgs.values()].map((o) => o.owner_id)
    return await notifyUsers(owners, (opts.type ?? 'sos_alert') as NotificationType, msg, {
      cluster_id: clusterId,
      url: '/dashboard',
      data: { category: 'safety', sos: true, ...(opts.data ?? {}) },
    })
  } catch (e) {
    console.error('[route] notifyPolice failed', e instanceof Error ? e.message : e)
    return { notified: 0, tokens: 0 }
  }
}
