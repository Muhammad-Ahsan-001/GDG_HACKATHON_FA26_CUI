// POST /route-report {cluster_id} -> {assignments: {org_id, org_name, distance_m, pushed}[]}
// Internal / scripts. Service-role callers may route any cluster; signed-in users only clusters that qualify
// (verified, or high/critical urgency) — the same rule the inline pipeline applies.
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { routeCluster, shouldRoute } from '../_shared/route.ts'
import { adminClient, requireServiceOrUser } from '../_shared/supabase.ts'
import type { ReportStatus, Urgency } from '../_shared/types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireServiceOrUser(req)
  const body = await readJson<{ cluster_id?: unknown }>(req)
  const clusterId = typeof body?.cluster_id === 'string' ? body.cluster_id.trim() : ''
  if (!UUID.test(clusterId)) throw new HttpError(400, 'cluster_id must be a uuid', 'bad_request')

  if (user) {
    const { data, error } = await adminClient().from('clusters').select('status, urgency, category').eq('id', clusterId).maybeSingle()
    if (error) throw new Error(`cluster lookup failed: ${error.message}`)
    if (!data) throw new HttpError(404, 'Cluster not found', 'not_found')
    const c = data as { status: ReportStatus; urgency: Urgency }
    if (!shouldRoute(c.status, c.urgency, (c as { category?: string }).category)) {
      throw new HttpError(403, 'Only verified or high-urgency pins can be routed', 'not_eligible')
    }
  }

  const routed = await routeCluster(clusterId)
  return json({
    assignments: routed.map((o) => ({
      org_id: o.org_id,
      org_name: o.org_name,
      org_type: o.org_type,
      distance_m: o.distance_m,
      pushed: o.pushed,
    })),
  })
})
