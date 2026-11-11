// POST /notify-nearby {cluster_id} -> {notified}
// Internal / scripts. Alerts citizens within NEARBY_RADIUS_M (excluding the cluster's reporters), at most once per
// cluster (clusters.nearby_notified_at). Signed-in users may only trigger it for verified high/critical pins.
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { notifyNearby } from '../_shared/notify.ts'
import { adminClient, requireServiceOrUser } from '../_shared/supabase.ts'
import type { ReportStatus, Urgency } from '../_shared/types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireServiceOrUser(req)
  const body = await readJson<{ cluster_id?: unknown }>(req)
  const clusterId = typeof body?.cluster_id === 'string' ? body.cluster_id.trim() : ''
  if (!UUID.test(clusterId)) throw new HttpError(400, 'cluster_id must be a uuid', 'bad_request')

  const { data, error } = await adminClient().from('clusters').select('status, urgency, nearby_notified_at')
    .eq('id', clusterId).maybeSingle()
  if (error) throw new Error(`cluster lookup failed: ${error.message}`)
  if (!data) throw new HttpError(404, 'Cluster not found', 'not_found')
  const c = data as { status: ReportStatus; urgency: Urgency; nearby_notified_at: string | null }
  if (user && !(c.status === 'verified' && (c.urgency === 'high' || c.urgency === 'critical'))) {
    throw new HttpError(403, 'Only verified high-urgency pins alert nearby citizens', 'not_eligible')
  }
  if (c.nearby_notified_at) return json({ notified: 0, already_notified_at: c.nearby_notified_at })

  const notified = await notifyNearby(clusterId)
  return json({ notified })
})
