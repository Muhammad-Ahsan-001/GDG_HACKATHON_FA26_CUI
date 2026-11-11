// POST /assignment-action {assignment_id, action: 'claim'|'start'|'resolve', note?}
//   -> {assignment_id, status, cluster_status}
// Applies the action AS THE USER (RPC apply_assignment_action checks org ownership + transitions), then tells the
// cluster's reporters (in-app + push, bilingual) and, on claim, the other alerted organisations.
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { type BilingualMessage, categoryLabel, notifyReporters, notifyUsers } from '../_shared/notify.ts'
import { adminClient, requireUser, userClient } from '../_shared/supabase.ts'
import type { AssignmentStatus, ReportStatus } from '../_shared/types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Action = 'claim' | 'start' | 'resolve'

function reporterMessage(action: Action, org: string, title_en: string, title_ur: string): BilingualMessage {
  switch (action) {
    case 'claim':
      return {
        title_en: `Help is on the way: ${org}`,
        title_ur: `مدد آ رہی ہے: ${org}`,
        body_en: `${org} has taken responsibility for your report "${title_en}".`,
        body_ur: `${org} نے آپ کی رپورٹ "${title_ur}" کی ذمہ داری لے لی ہے۔`,
      }
    case 'start':
      return {
        title_en: `Work started: ${title_en}`,
        title_ur: `کام شروع ہو گیا: ${title_ur}`,
        body_en: `${org} is working on it now.`,
        body_ur: `${org} اس پر ابھی کام کر رہا ہے۔`,
      }
    case 'resolve':
      return {
        title_en: `Resolved: ${title_en}`,
        title_ur: `مسئلہ حل ہو گیا: ${title_ur}`,
        body_en: `${org} marked this issue as resolved. Thank you for reporting.`,
        body_ur: `${org} نے یہ مسئلہ حل کر دیا ہے۔ رپورٹ کرنے کا شکریہ۔`,
      }
  }
}

function mapRpcError(error: { message?: string; details?: string; hint?: string; code?: string }): HttpError {
  // apply_assignment_action raises short machine codes: auth_required | invalid_action | assignment_not_found | forbidden
  const msg = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`
  const code = error.code ?? ''
  if (/forbidden|not.?(the )?owner|permission|not allowed|denied|do not own/i.test(msg) || code === '42501') {
    return new HttpError(403, 'You do not manage the organisation for this assignment', 'forbidden')
  }
  if (/auth.?required|not.?auth|unauthori[sz]ed|jwt/i.test(msg) || code === '28000' || code === 'PGRST301') {
    return new HttpError(401, 'Sign in required', 'unauthorized')
  }
  if (/not.?found/i.test(msg) || code === 'P0002') return new HttpError(404, 'Assignment not found', 'not_found')
  if (/invalid_action/i.test(msg)) return new HttpError(400, "action must be 'claim', 'start' or 'resolve'", 'bad_request')
  if (/invalid|transition|already|cannot/i.test(msg)) {
    return new HttpError(409, error.message || 'Action not allowed in the current state', 'invalid_transition')
  }
  console.error('[assignment-action] rpc failed', code, error.message)
  return new HttpError(400, error.message || 'Action failed', code || 'action_failed')
}

interface RpcResult {
  assignment_id?: string
  status?: AssignmentStatus
  previous_status?: AssignmentStatus
  changed?: boolean
  cluster_id?: string
  cluster_status?: ReportStatus
  org_id?: string
  org_name?: string
  reporter_ids?: string[] | null
  other_org_owner_ids?: string[] | null
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const t0 = performance.now()
  const user = await requireUser(req)
  const body = await readJson<{ assignment_id?: unknown; action?: unknown; note?: unknown }>(req)
  const assignmentId = typeof body?.assignment_id === 'string' ? body.assignment_id.trim() : ''
  const action = body?.action
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : ''
  if (!UUID.test(assignmentId)) throw new HttpError(400, 'assignment_id must be a uuid', 'bad_request')
  if (action !== 'claim' && action !== 'start' && action !== 'resolve') {
    throw new HttpError(400, "action must be 'claim', 'start' or 'resolve'", 'bad_request')
  }

  const { data, error } = await userClient(req).rpc('apply_assignment_action', {
    p_assignment_id: assignmentId,
    p_action: action,
    p_note: note || null,
  })
  if (error) throw mapRpcError(error)
  const r = (data ?? {}) as RpcResult
  const admin = adminClient()
  const clusterId = r.cluster_id ?? null

  // the RPC is forward-only + idempotent: a repeated tap (changed = false) must not re-notify anyone
  if (clusterId && r.changed !== false) {
    const { data: c } = await admin.from('clusters').select('category, title_en, title_ur, status')
      .eq('id', clusterId).maybeSingle()
    const cl = c as { category: string; title_en: string | null; title_ur: string | null; status: ReportStatus } | null
    let orgName = r.org_name ?? ''
    if (!orgName && r.org_id) {
      const { data: o } = await admin.from('organizations').select('name').eq('id', r.org_id).maybeSingle()
      orgName = (o as { name?: string } | null)?.name ?? ''
    }
    orgName = orgName || 'A responder'
    const cat = categoryLabel(cl?.category)
    const title_en = cl?.title_en ?? cat.en
    const title_ur = cl?.title_ur ?? cat.ur
    const clusterStatus = r.cluster_status ?? cl?.status ?? ''

    const tasks: Promise<unknown>[] = [
      notifyReporters(clusterId, 'status_change', reporterMessage(action, orgName, title_en, title_ur), {
        reporterIds: r.reporter_ids ?? undefined,
        data: { action, assignment_id: assignmentId, org_name: orgName, status: clusterStatus },
      }),
    ]
    if (action === 'claim' || action === 'resolve') {
      // tell the other alerted organisations so they do not send a second team / know it is closed
      tasks.push((async () => {
        let ownerIds = r.other_org_owner_ids ?? null
        if (!ownerIds) {
          const { data: others } = await admin.from('assignments').select('org_id')
            .eq('cluster_id', clusterId).neq('id', assignmentId)
          const otherOrgIds = ((others ?? []) as { org_id: string }[]).map((o) => o.org_id).filter((id) => id !== r.org_id)
          const { data: owners } = otherOrgIds.length
            ? await admin.from('organizations').select('owner_id').in('id', otherOrgIds)
            : { data: [] }
          ownerIds = ((owners ?? []) as { owner_id: string }[]).map((o) => o.owner_id)
        }
        ownerIds = ownerIds.filter((id) => id && id !== user.id)
        if (!ownerIds.length) return
        const msg = action === 'claim'
          ? {
            title_en: `Claimed by ${orgName}`,
            title_ur: `${orgName} نے ذمہ داری لے لی`,
            body_en: `${title_en} — ${orgName} is handling it. No need to send another team.`,
            body_ur: `${title_ur} — ${orgName} اسے سنبھال رہا ہے۔ دوسری ٹیم بھیجنے کی ضرورت نہیں۔`,
          }
          : {
            title_en: `Resolved by ${orgName}`,
            title_ur: `${orgName} نے مسئلہ حل کر دیا`,
            body_en: `${title_en} — closed by ${orgName}. Your alert for it is closed too.`,
            body_ur: `${title_ur} — ${orgName} نے حل کر دیا۔ آپ کی اطلاع بھی بند کر دی گئی ہے۔`,
          }
        await notifyUsers(ownerIds, 'status_change', msg, {
          cluster_id: clusterId,
          url: '/dashboard',
          data: { action: action === 'claim' ? 'claimed' : 'resolved', assignment_id: assignmentId, org_name: orgName },
        })
      })())
    }
    await Promise.all(tasks)
  }

  const res = {
    assignment_id: r.assignment_id ?? assignmentId,
    status: (r.status ?? (action === 'claim' ? 'claimed' : action === 'start' ? 'in_progress' : 'resolved')) as AssignmentStatus,
    cluster_status: (r.cluster_status ?? 'unconfirmed') as ReportStatus,
  }
  console.log(JSON.stringify({
    fn: 'assignment-action', action, cluster_id: clusterId, changed: r.changed ?? null, ...res,
    ms: Math.round(performance.now() - t0),
  }))
  return json(res)
})
