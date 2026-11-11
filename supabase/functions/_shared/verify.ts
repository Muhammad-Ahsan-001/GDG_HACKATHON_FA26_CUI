// Cluster verification: deterministic heuristic guard rails around the AI confidence score (CONTRACT §2
// "Verification rule"). verifyCluster() recomputes and writes clusters.status/confidence/ai_reason and the same
// fields on every report of the cluster.
import { scoreVerification } from './ai.ts'
import { VERIFY_AI_CLAMP, VERIFY_THRESHOLD } from './config.ts'
import { distanceM, parsePoint } from './geocode.ts'
import { HttpError } from './http.ts'
import { adminClient } from './supabase.ts'
import type { PhotoCheck, Provider, ReportStatus, VerificationInput } from './types.ts'

/** Hard cap on the AI scoring call inside the request path; on timeout the heuristic alone decides. */
const AI_SCORE_BUDGET_MS = 9000

export interface VerifyResult {
  cluster_id: string
  status: ReportStatus
  previous_status: ReportStatus
  confidence: number
  /** English reason (stored in clusters.ai_reason / reports.ai_reason) */
  reason: string
  reason_ur: string
  provider: Provider | 'heuristic'
  heuristic: number
  changed_to_verified: boolean
}

export interface HeuristicFeatures {
  independent_reporters: number
  confirms: number
  disputes: number
  any_photo_match: boolean
  any_photo_contradicts: boolean
  avg_trust: number
  modes_differ: boolean
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const round3 = (x: number) => Math.round(x * 1000) / 1000

/** The exact CONTRACT heuristic. 2 reporters (voice + text) -> 0.60 + 0.15 bonus = 0.75. */
export function heuristicScore(f: HeuristicFeatures): number {
  const n = Math.max(1, f.independent_reporters)
  const base = clamp(
    0.35 +
      0.25 * Math.min(n - 1, 2) +
      0.10 * Math.min(f.confirms, 3) -
      0.15 * Math.min(f.disputes, 3) +
      (f.any_photo_match ? 0.10 : 0) -
      (f.any_photo_contradicts ? 0.10 : 0) +
      0.05 * (f.avg_trust - 0.5) * 2,
    0,
    1,
  )
  const bonus = n >= 2 && (f.modes_differ || f.any_photo_match) ? 0.15 : 0
  return round3(Math.min(1, base + bonus))
}

/** Status rule; `current` in_progress/resolved is never downgraded. */
export function decideStatus(final: number, f: HeuristicFeatures, current: ReportStatus): ReportStatus {
  if (current === 'in_progress' || current === 'resolved') return current
  const n = Math.max(1, f.independent_reporters)
  if (f.disputes > f.confirms + (n - 1)) return 'disputed'
  // a single report with no confirmations stays unconfirmed whatever the score says
  if (n === 1 && f.confirms === 0) return 'unconfirmed'
  return final >= VERIFY_THRESHOLD ? 'verified' : 'unconfirmed'
}

function heuristicReason(f: HeuristicFeatures): { en: string; ur: string } {
  const n = f.independent_reporters
  const parts_en = [`${n} independent reporter${n === 1 ? '' : 's'}`]
  const parts_ur = [`${n} الگ رپورٹ کنندگان`]
  if (f.confirms) {
    parts_en.push(`${f.confirms} confirmation${f.confirms === 1 ? '' : 's'}`)
    parts_ur.push(`${f.confirms} تصدیقیں`)
  }
  if (f.disputes) {
    parts_en.push(`${f.disputes} dispute${f.disputes === 1 ? '' : 's'}`)
    parts_ur.push(`${f.disputes} اعتراضات`)
  }
  if (f.any_photo_match) {
    parts_en.push('photo matches the report')
    parts_ur.push('تصویر رپورٹ سے ملتی ہے')
  } else if (f.any_photo_contradicts) {
    parts_en.push('photo does not match')
    parts_ur.push('تصویر رپورٹ سے نہیں ملتی')
  }
  if (f.modes_differ && n >= 2) {
    parts_en.push('different input types')
    parts_ur.push('مختلف طریقوں سے رپورٹ')
  }
  return { en: `Heuristic: ${parts_en.join(', ')}.`, ur: `اندازہ: ${parts_ur.join('، ')}۔` }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

interface ReportRow {
  id: string
  reporter_id: string
  summary_en: string | null
  created_at: string
  location: unknown
  input_modes: string[] | null
  photo_check: PhotoCheck | null
}

/**
 * Recompute a cluster's confidence + status and persist it on the cluster and all its reports.
 * Throws HttpError(404) when the cluster does not exist.
 */
export async function verifyCluster(clusterId: string): Promise<VerifyResult> {
  const t0 = performance.now()
  const admin = adminClient()
  const [cRes, rRes] = await Promise.all([
    admin.from('clusters')
      .select('id, category, urgency, status, confidence, ai_reason, confirm_count, dispute_count, centroid')
      .eq('id', clusterId).maybeSingle(),
    admin.from('reports')
      .select('id, reporter_id, summary_en, created_at, location, input_modes, photo_check')
      .eq('cluster_id', clusterId).eq('is_spam', false).order('created_at', { ascending: true }),
  ])
  if (cRes.error) throw new Error(`verify: cluster lookup failed: ${cRes.error.message}`)
  if (!cRes.data) throw new HttpError(404, 'Cluster not found', 'not_found')
  if (rRes.error) throw new Error(`verify: reports lookup failed: ${rRes.error.message}`)
  const cluster = cRes.data as {
    id: string; category: string; urgency: string; status: ReportStatus; confidence: number
    ai_reason: string | null; confirm_count: number; dispute_count: number; centroid: unknown
  }
  const reports = (rRes.data ?? []) as ReportRow[]

  const reporterIds = [...new Set(reports.map((r) => r.reporter_id))]
  const trustOf = new Map<string, number>()
  if (reporterIds.length) {
    const { data: profs, error } = await admin.from('profiles').select('id, trust_score').in('id', reporterIds)
    if (error) console.warn('[verify] trust lookup failed', error.message)
    for (const p of (profs ?? []) as { id: string; trust_score: number | null }[]) {
      trustOf.set(p.id, typeof p.trust_score === 'number' ? p.trust_score : 0.5)
    }
  }

  const n = Math.max(1, reporterIds.length)
  const avgTrust = reporterIds.length
    ? reporterIds.reduce((s, id) => s + (trustOf.get(id) ?? 0.5), 0) / reporterIds.length
    : 0.5
  const photoChecks = reports.map((r) => r.photo_check).filter((p): p is PhotoCheck => Boolean(p))
  const modeSignatures = new Set(reports.map((r) => [...(r.input_modes ?? [])].sort().join('+')))
  const features: HeuristicFeatures = {
    independent_reporters: reporterIds.length || 1,
    confirms: Math.max(0, cluster.confirm_count ?? 0),
    disputes: Math.max(0, cluster.dispute_count ?? 0),
    any_photo_match: photoChecks.some((p) => p.matches_claim === true),
    any_photo_contradicts: photoChecks.some((p) => p.matches_claim === false),
    avg_trust: avgTrust,
    modes_differ: modeSignatures.size > 1,
  }
  const heuristic = heuristicScore(features)

  // ---- AI score, clamped to heuristic ± VERIFY_AI_CLAMP
  const centre = parsePoint(cluster.centroid)
  const now = Date.now()
  const input: VerificationInput = {
    category: cluster.category,
    urgency: cluster.urgency,
    reports: reports.map((r) => {
      const p = parsePoint(r.location)
      return {
        summary_en: r.summary_en ?? '',
        minutes_ago: Math.max(0, (now - new Date(r.created_at).getTime()) / 60000),
        distance_m: centre && p ? distanceM(centre, p) : 0,
        reporter_trust: trustOf.get(r.reporter_id) ?? 0.5,
        has_photo: Boolean(r.photo_check),
        photo_matches: r.photo_check ? r.photo_check.matches_claim : null,
        modes: r.input_modes ?? [],
      }
    }),
    independent_reporters: n,
    confirms: features.confirms,
    disputes: features.disputes,
    heuristic,
  }

  let final = heuristic
  let reason = heuristicReason(features)
  let provider: VerifyResult['provider'] = 'heuristic'
  try {
    const ai = await withTimeout(scoreVerification(input), AI_SCORE_BUDGET_MS, 'scoreVerification')
    final = clamp(ai.confidence, heuristic - VERIFY_AI_CLAMP, heuristic + VERIFY_AI_CLAMP)
    reason = { en: ai.reason_en, ur: ai.reason_ur || ai.reason_en }
    provider = ai.meta.provider
  } catch (e) {
    console.warn('[verify] AI score unavailable, heuristic only:', e instanceof Error ? e.message : e)
  }
  // Guard rail: independent corroboration with no disputes and no contradicting photo cannot be pulled below the
  // threshold by the AI (makes the 2-reporter voice + text demo deterministic: heuristic 0.75 -> verified).
  if (
    n >= 2 && features.disputes === 0 && !features.any_photo_contradicts && heuristic >= VERIFY_THRESHOLD
  ) final = Math.max(final, VERIFY_THRESHOLD)
  final = round3(clamp(final, 0, 1))

  const previous = cluster.status
  const status = decideStatus(final, features, previous)
  const nowIso = new Date().toISOString()

  // Conditional on the status we read, so two concurrent verifications cannot both claim the transition.
  const { data: upd, error: updErr } = await admin.from('clusters')
    .update({ status, confidence: final, ai_reason: reason.en, updated_at: nowIso })
    .eq('id', clusterId).eq('status', previous).select('id')
  if (updErr) throw new Error(`verify: cluster update failed: ${updErr.message}`)
  let finalStatus = status
  let transitioned = (upd ?? []).length > 0
  if (!transitioned) {
    // someone changed the status meanwhile (vote / claim / another report): keep theirs, refresh the score only
    const { data: cur } = await admin.from('clusters').update({ confidence: final, ai_reason: reason.en, updated_at: nowIso })
      .eq('id', clusterId).select('status').maybeSingle()
    finalStatus = ((cur as { status?: ReportStatus } | null)?.status ?? status)
    transitioned = false
  }
  const { error: repErr } = await admin.from('reports')
    .update({ status: finalStatus, confidence: final, ai_reason: reason.en, updated_at: nowIso })
    .eq('cluster_id', clusterId).eq('is_spam', false)
  if (repErr) console.error('[verify] reports update failed', repErr.message)

  const result: VerifyResult = {
    cluster_id: clusterId,
    status: finalStatus,
    previous_status: previous,
    confidence: final,
    reason: reason.en,
    reason_ur: reason.ur,
    provider,
    heuristic,
    changed_to_verified: transitioned && previous !== 'verified' && finalStatus === 'verified',
  }
  console.log(JSON.stringify({
    fn: 'verify', cluster_id: clusterId, n, confirms: features.confirms, disputes: features.disputes,
    heuristic, final, previous, status: finalStatus, provider, ms: Math.round(performance.now() - t0),
  }))
  return result
}
