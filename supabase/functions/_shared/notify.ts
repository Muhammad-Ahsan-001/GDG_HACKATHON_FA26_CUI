// In-app notifications (notifications table -> realtime) + FCM push, bilingual (en/ur).
// notifyUsers(): the one primitive (insert rows, then push in the background per user language).
// notifyReporters(): everyone who reported into a cluster. notifyNearby(): verified high/critical alerts for
// citizens within NEARBY_RADIUS_M (excluding the cluster's reporters), at most once per cluster.
import { NEARBY_RADIUS_M } from './config.ts'
import { sendToTokens } from './fcm.ts'
import { parsePoint } from './geocode.ts'
import { background } from './http.ts'
import { adminClient } from './supabase.ts'
import type { Category, Lang, Urgency } from './types.ts'

export type NotificationType = 'new_assignment' | 'status_change' | 'nearby_alert' | 'food_alert' | 'verified'

export interface BilingualMessage { title_en: string; title_ur: string; body_en: string; body_ur: string }

export interface NotifyOptions {
  cluster_id?: string | null
  report_id?: string | null
  /** app path opened when the notification is tapped (default /pin/<cluster_id>) */
  url?: string
  data?: Record<string, string | number | boolean | null | undefined>
  /** false = insert notification rows only, no FCM push */
  push?: boolean
}

export interface NotifyResult { notified: number; tokens: number }

export const CATEGORY_LABEL: Record<Category, { en: string; ur: string }> = {
  hazard: { en: 'Hazard', ur: 'خطرہ' },
  fire: { en: 'Fire', ur: 'آگ' },
  flood: { en: 'Flooding', ur: 'سیلاب' },
  water: { en: 'Water problem', ur: 'پانی کا مسئلہ' },
  food: { en: 'Surplus food', ur: 'اضافی کھانا' },
  health: { en: 'Health', ur: 'صحت' },
  safety: { en: 'Safety', ur: 'حفاظت' },
  other: { en: 'Issue', ur: 'مسئلہ' },
}

export const URGENCY_LABEL: Record<Urgency, { en: string; ur: string }> = {
  low: { en: 'Low', ur: 'کم' },
  medium: { en: 'Medium', ur: 'درمیانہ' },
  high: { en: 'High', ur: 'زیادہ' },
  critical: { en: 'Critical', ur: 'انتہائی فوری' },
}

export function categoryLabel(c: string | null | undefined): { en: string; ur: string } {
  return CATEGORY_LABEL[(c ?? 'other') as Category] ?? CATEGORY_LABEL.other
}

export function urgencyLabel(u: string | null | undefined): { en: string; ur: string } {
  return URGENCY_LABEL[(u ?? 'medium') as Urgency] ?? URGENCY_LABEL.medium
}

function uniq(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))]
}

/** Push to (token, language) pairs grouped by language; runs in the background. */
function pushByLanguage(
  rows: { token: string; lang: Lang }[],
  type: string,
  msg: BilingualMessage,
  clusterId: string | null | undefined,
  url: string,
  data: NotifyOptions['data'],
): void {
  const byLang: Record<Lang, string[]> = { en: [], ur: [] }
  for (const r of rows) byLang[r.lang === 'en' ? 'en' : 'ur'].push(r.token)
  for (const lang of ['en', 'ur'] as const) {
    if (!byLang[lang].length) continue
    background(sendToTokens(byLang[lang], {
      title: lang === 'en' ? msg.title_en : msg.title_ur,
      body: lang === 'en' ? msg.body_en : msg.body_ur,
      type,
      cluster_id: clusterId ?? undefined,
      link: url,
      data,
    }))
  }
}

/**
 * Insert one notifications row per user (awaited, so realtime fires before the HTTP response) and push to all
 * of their device tokens in their profile language (background). Never throws.
 */
export async function notifyUsers(
  userIds: (string | null | undefined)[],
  type: NotificationType,
  msg: BilingualMessage,
  opts: NotifyOptions = {},
): Promise<NotifyResult> {
  const users = uniq(userIds)
  if (!users.length) return { notified: 0, tokens: 0 }
  const admin = adminClient()
  const url = opts.url ?? (opts.cluster_id ? `/pin/${opts.cluster_id}` : '/map')
  const data = { ...(opts.data ?? {}), url, cluster_id: opts.cluster_id ?? undefined }
  try {
    const rows = users.map((user_id) => ({
      user_id,
      type,
      cluster_id: opts.cluster_id ?? null,
      report_id: opts.report_id ?? null,
      title_en: msg.title_en,
      title_ur: msg.title_ur,
      body_en: msg.body_en,
      body_ur: msg.body_ur,
      data,
    }))
    const [ins, tok, prof] = await Promise.all([
      admin.from('notifications').insert(rows),
      opts.push === false
        ? Promise.resolve({ data: [] as { user_id: string; fcm_token: string }[], error: null })
        : admin.from('device_tokens').select('user_id, fcm_token').in('user_id', users),
      opts.push === false
        ? Promise.resolve({ data: [] as { id: string; language: string }[], error: null })
        : admin.from('profiles').select('id, language').in('id', users),
    ])
    if (ins.error) console.error('[notify] insert notifications failed', ins.error.message)
    if (tok.error) console.warn('[notify] device_tokens lookup failed', tok.error.message)
    const langOf = new Map<string, Lang>()
    for (const p of (prof.data ?? []) as { id: string; language: string }[]) {
      langOf.set(p.id, p.language === 'en' ? 'en' : 'ur')
    }
    const tokens = ((tok.data ?? []) as { user_id: string; fcm_token: string }[])
      .filter((t) => t.fcm_token)
      .map((t) => ({ token: t.fcm_token, lang: langOf.get(t.user_id) ?? 'ur' as Lang }))
    if (tokens.length) pushByLanguage(tokens, type, msg, opts.cluster_id, url, opts.data)
    return { notified: ins.error ? 0 : users.length, tokens: tokens.length }
  } catch (e) {
    console.error('[notify] notifyUsers failed', e instanceof Error ? e.message : e)
    return { notified: 0, tokens: 0 }
  }
}

/** Distinct reporter ids of a cluster's (non-spam) reports. */
export async function clusterReporterIds(clusterId: string): Promise<string[]> {
  const { data, error } = await adminClient().from('reports').select('reporter_id')
    .eq('cluster_id', clusterId).eq('is_spam', false)
  if (error) {
    console.warn('[notify] reporter lookup failed', error.message)
    return []
  }
  return uniq((data ?? []).map((r: { reporter_id: string }) => r.reporter_id))
}

/** Notify everyone who reported into the cluster (status changes, verification). Never throws. */
export async function notifyReporters(
  clusterId: string,
  type: NotificationType,
  msg: BilingualMessage,
  opts: NotifyOptions & { reporterIds?: string[]; excludeUserIds?: string[] } = {},
): Promise<NotifyResult> {
  const ids = opts.reporterIds?.length ? uniq(opts.reporterIds) : await clusterReporterIds(clusterId)
  const exclude = new Set(opts.excludeUserIds ?? [])
  const targets = ids.filter((id) => !exclude.has(id))
  return await notifyUsers(targets, type, msg, { ...opts, cluster_id: clusterId })
}

/**
 * Alert citizens within NEARBY_RADIUS_M of a verified high/critical cluster (excluding its reporters).
 * Idempotent: claims clusters.nearby_notified_at atomically, so each cluster alerts at most once.
 * Returns the number of citizens notified. Never throws.
 */
export async function notifyNearby(clusterId: string): Promise<number> {
  const admin = adminClient()
  const claimedAt = new Date().toISOString()
  const { data: cluster, error } = await admin.from('clusters')
    .update({ nearby_notified_at: claimedAt })
    .eq('id', clusterId)
    .is('nearby_notified_at', null)
    .select('id, category, urgency, status, title_en, title_ur, centroid, food_servings, food_type, safe_until')
    .maybeSingle()
  if (error) {
    console.error('[notify] nearby claim failed', error.message)
    return 0
  }
  if (!cluster) {
    console.log('[notify] nearby already sent for', clusterId)
    return 0
  }
  const release = async () => {
    await admin.from('clusters').update({ nearby_notified_at: null }).eq('id', clusterId).eq('nearby_notified_at', claimedAt)
  }
  try {
    const point = parsePoint(cluster.centroid)
    if (!point) {
      console.warn('[notify] cluster has no parseable centroid', clusterId)
      await release()
      return 0
    }
    const reporters = await clusterReporterIds(clusterId)
    const { data: rows, error: rpcErr } = await admin.rpc('nearby_citizen_tokens', {
      p_lat: point.lat,
      p_lng: point.lng,
      p_radius_m: NEARBY_RADIUS_M,
      p_exclude: reporters,
    })
    if (rpcErr) {
      console.error('[notify] nearby_citizen_tokens failed', rpcErr.message)
      await release()
      return 0
    }
    const list = ((rows ?? []) as { user_id: string; fcm_token: string | null; language: string | null }[])
      .filter((r) => r.user_id && !reporters.includes(r.user_id))
    const users = uniq(list.map((r) => r.user_id))
    if (!users.length) {
      console.log('[notify] no nearby citizens for', clusterId)
      return 0
    }
    const cat = categoryLabel(cluster.category)
    const title_en = String(cluster.title_en ?? cat.en)
    const title_ur = String(cluster.title_ur ?? cat.ur)
    const foodOffer = cluster.category === 'food' && Boolean(cluster.food_servings || cluster.food_type || cluster.safe_until)
    const msg: BilingualMessage = foodOffer
      ? {
        title_en: `Free food available near you`,
        title_ur: `آپ کے قریب مفت کھانا دستیاب ہے`,
        body_en: `${title_en}. Within 1 km of you — tap to see where.`,
        body_ur: `${title_ur}۔ آپ سے ایک کلومیٹر کے اندر — جگہ دیکھنے کے لیے ٹیپ کریں۔`,
      }
      : {
        title_en: `Verified ${cat.en.toLowerCase()} alert near you`,
        title_ur: `آپ کے قریب تصدیق شدہ انتباہ: ${cat.ur}`,
        body_en: `${title_en}. Within 1 km of you — stay safe and avoid the area.`,
        body_ur: `${title_ur}۔ آپ سے ایک کلومیٹر کے اندر — محتاط رہیں اور اس جگہ سے دور رہیں۔`,
      }
    const url = `/pin/${clusterId}`
    const data = { category: String(cluster.category), urgency: String(cluster.urgency) }
    const { error: insErr } = await admin.from('notifications').insert(users.map((user_id) => ({
      user_id,
      type: 'nearby_alert',
      cluster_id: clusterId,
      title_en: msg.title_en,
      title_ur: msg.title_ur,
      body_en: msg.body_en,
      body_ur: msg.body_ur,
      data: { ...data, url, cluster_id: clusterId },
    })))
    if (insErr) console.error('[notify] nearby notifications insert failed', insErr.message)
    const tokens = list.filter((r) => r.fcm_token)
      .map((r) => ({ token: r.fcm_token as string, lang: (r.language === 'en' ? 'en' : 'ur') as Lang }))
    if (tokens.length) pushByLanguage(tokens, 'nearby_alert', msg, clusterId, url, data)
    console.log(`[notify] nearby alert cluster=${clusterId} users=${users.length} tokens=${tokens.length}`)
    return users.length
  } catch (e) {
    console.error('[notify] notifyNearby failed', e instanceof Error ? e.message : e)
    await release().catch(() => {})
    return 0
  }
}
