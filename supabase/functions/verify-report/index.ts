// POST /verify-report {cluster_id} -> {cluster_id, status, confidence, reason, provider}
// Internal / scripts (service role) or any signed-in user. The hot path runs _shared/verify.ts inline instead.
// When the cluster just became verified it is escalated exactly like the inline path (route + nearby alerts).
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { escalateCluster } from '../_shared/route.ts'
import { requireServiceOrUser } from '../_shared/supabase.ts'
import { verifyCluster } from '../_shared/verify.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  await requireServiceOrUser(req)
  const body = await readJson<{ cluster_id?: unknown }>(req)
  const clusterId = typeof body?.cluster_id === 'string' ? body.cluster_id.trim() : ''
  if (!UUID.test(clusterId)) throw new HttpError(400, 'cluster_id must be a uuid', 'bad_request')

  const v = await verifyCluster(clusterId)
  const routed = v.changed_to_verified ? await escalateCluster(clusterId, v) : []
  return json({
    cluster_id: v.cluster_id,
    status: v.status,
    confidence: v.confidence,
    reason: v.reason,
    reason_ur: v.reason_ur,
    provider: v.provider,
    heuristic: v.heuristic,
    previous_status: v.previous_status,
    changed_to_verified: v.changed_to_verified,
    routed: routed.map((o) => ({ org_name: o.org_name, org_type: o.org_type, distance_m: o.distance_m })),
  })
})
