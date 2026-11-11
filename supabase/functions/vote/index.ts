// POST /vote {cluster_id, vote: 'confirm'|'dispute'} -> {status, confidence, confirm_count, dispute_count, ai_reason}
// Casts the vote AS THE USER (RPC cast_vote), re-verifies the cluster inline and, when it just became verified,
// routes it to responders (+ nearby alerts in the background for high/critical).
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { escalateCluster } from '../_shared/route.ts'
import { adminClient, requireUser, userClient } from '../_shared/supabase.ts'
import type { ReportStatus } from '../_shared/types.ts'
import { verifyCluster } from '../_shared/verify.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const t0 = performance.now()
  const user = await requireUser(req)
  const body = await readJson<{ cluster_id?: unknown; vote?: unknown }>(req)
  const clusterId = typeof body?.cluster_id === 'string' ? body.cluster_id.trim() : ''
  const vote = body?.vote
  if (!UUID.test(clusterId)) throw new HttpError(400, 'cluster_id must be a uuid', 'bad_request')
  if (vote !== 'confirm' && vote !== 'dispute') throw new HttpError(400, "vote must be 'confirm' or 'dispute'", 'bad_request')

  const { data, error } = await userClient(req).rpc('cast_vote', { p_cluster_id: clusterId, p_vote: vote })
  if (error) {
    const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`
    if (/own_report/i.test(msg)) {
      throw new HttpError(409, 'You cannot vote on your own report', 'own_report')
    }
    if (/cluster_not_found|cluster_has_no_reports|not.?found/i.test(msg) || error.code === 'P0002') {
      throw new HttpError(404, 'Pin not found', 'not_found')
    }
    if (/auth.?required|not.?auth|unauthori[sz]ed|jwt/i.test(msg) || error.code === '28000' || error.code === 'PGRST301') {
      throw new HttpError(401, 'Sign in required', 'unauthorized')
    }
    if (/invalid_vote/i.test(msg)) throw new HttpError(400, "vote must be 'confirm' or 'dispute'", 'bad_request')
    console.error('[vote] cast_vote failed', error.code, error.message)
    throw new HttpError(400, error.message || 'Vote failed', error.code || 'vote_failed')
  }
  const counts = (data ?? {}) as { confirm_count?: number; dispute_count?: number }

  let status: ReportStatus
  let confidence: number
  let aiReason: string | null
  try {
    const v = await verifyCluster(clusterId)
    status = v.status
    confidence = v.confidence
    aiReason = v.reason || null
    if (v.changed_to_verified) await escalateCluster(clusterId, v)
  } catch (e) {
    if (e instanceof HttpError) throw e
    console.error('[vote] verify failed', e instanceof Error ? e.message : e)
    const { data: c } = await adminClient().from('clusters').select('status, confidence, ai_reason')
      .eq('id', clusterId).maybeSingle()
    const row = c as { status: ReportStatus; confidence: number; ai_reason: string | null } | null
    status = row?.status ?? 'unconfirmed'
    confidence = row?.confidence ?? 0
    aiReason = row?.ai_reason ?? null
  }

  let confirm_count = Number(counts.confirm_count)
  let dispute_count = Number(counts.dispute_count)
  if (!Number.isFinite(confirm_count) || !Number.isFinite(dispute_count)) {
    const { data: c } = await adminClient().from('clusters').select('confirm_count, dispute_count')
      .eq('id', clusterId).maybeSingle()
    const row = c as { confirm_count: number; dispute_count: number } | null
    confirm_count = row?.confirm_count ?? 0
    dispute_count = row?.dispute_count ?? 0
  }

  console.log(JSON.stringify({
    fn: 'vote', cluster_id: clusterId, user: user.id, vote, status, confidence, confirm_count, dispute_count,
    ms: Math.round(performance.now() - t0),
  }))
  return json({ status, confidence, confirm_count, dispute_count, ai_reason: aiReason })
})
