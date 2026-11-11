// Admin console data access: typed wrappers for the admin-only RPCs (supabase/migrations/20261111000020_admin.sql).
// Every RPC raises 'forbidden' for non-admins. Lists return { total, rows }.
import { supabase } from './supabase'
import type { AttributeMap, ChatTurn, UserUrgency } from './attributes'
import type { SosStatus, SosTrigger, ThreatLevel } from './sos'
import type { AssignmentStatus, Category, OrgType, ReportStatus, Role, Urgency } from './types'

export interface Page<T> { total: number; rows: T[] }

export interface AdminOverview {
  generated_at: string
  users: { total: number; anonymous: number; new_today: number; active_today: number; by_role: Record<Role, number> }
  orgs: { total: number; approved: number; pending: number; by_type: Partial<Record<OrgType, number>> }
  clusters: { total: number; private: number; open: number; by_status: Record<ReportStatus, number>; by_category: Partial<Record<Category, number>> }
  reports: { total: number; spam: number; private: number; today: number; voice: number; photo: number; text: number; avg_confidence: number }
  assignments: { total: number; by_status: Record<AssignmentStatus, number> }
  sos: { total: number; active: number; high_threat: number; by_status: Record<SosStatus, number> }
  notifications: { total: number; today: number; unread: number }
  response: {
    avg_min_report_to_claim: number | null
    avg_min_claim_to_resolve: number | null
    avg_min_alert_to_claim: number | null
    claimed_count: number
    resolved_count: number
  }
  per_day: { day: string; reports: number; spam: number; sos: number }[]
  top_areas: { area: string; count: number }[]
}

export interface AdminUser {
  id: string
  role: Role
  display_name: string | null
  phone: string | null
  language: 'ur' | 'en'
  trust_score: number
  is_demo: boolean
  home_area: string | null
  onboarded_at: string | null
  last_location_at: string | null
  created_at: string
  email: string | null
  auth_phone: string | null
  last_sign_in_at: string | null
  is_anonymous: boolean
  report_count: number
  spam_count: number
  org_count: number
  sos_count: number
}

export interface AdminMedia { type: 'audio' | 'image'; bucket: string; path: string; url: string | null }

export interface AdminReport {
  id: string
  created_at: string
  updated_at: string
  category: Category
  urgency: Urgency
  status: ReportStatus
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  transcript: string | null
  language: string | null
  input_modes: string[]
  attributes: AttributeMap | null
  conversation: ChatTurn[] | null
  user_urgency: UserUrgency | null
  confidence: number
  ai_reason: string | null
  ai_provider: string | null
  photo_check: { matches_claim?: boolean; severity?: string; notes?: string } | null
  is_spam: boolean
  spam_reason: string | null
  is_private: boolean
  address_text: string | null
  location_source: string | null
  lat: number | null
  lng: number | null
  food_servings: number | null
  food_type: string | null
  safe_until: string | null
  cluster_id: string | null
  cluster_status: ReportStatus | null
  cluster_report_count: number | null
  cluster_confidence: number | null
  reporter_id: string
  reporter_name: string | null
  reporter_email: string | null
  reporter_trust: number | null
  reporter_role: Role | null
  reporter_anonymous: boolean
  media: AdminMedia[]
}

export interface AdminSosChunk { seq: number; audio_path: string | null; transcript: string | null; threat_level: ThreatLevel | null; created_at: string }
export interface AdminSosPolice {
  org_id: string; org_name: string; org_type: OrgType; status: AssignmentStatus; distance_m: number | null
  alerted_at: string; claimed_at: string | null; in_progress_at: string | null; resolved_at: string | null
}
export interface AdminSos {
  id: string
  user_id: string
  user_name: string | null
  user_email: string | null
  user_phone: string | null
  user_anonymous: boolean
  trigger: SosTrigger
  status: SosStatus
  started_at: string
  ended_at: string | null
  alerted_at: string | null
  threat_level: ThreatLevel
  threat_reason: string | null
  transcript: string | null
  cluster_id: string | null
  cluster_status: ReportStatus | null
  lat: number | null
  lng: number | null
  last_location_at: string | null
  last_accuracy_m: number | null
  updated_at: string
  chunks: AdminSosChunk[]
  police: AdminSosPolice[]
}

export interface AdminAssignment {
  id: string
  status: AssignmentStatus
  distance_m: number | null
  note: string | null
  alerted_at: string
  claimed_at: string | null
  in_progress_at: string | null
  resolved_at: string | null
  claimed_by_name: string | null
  org_id: string
  org_name: string
  org_type: OrgType
  cluster_id: string
  category: Category
  urgency: Urgency
  cluster_status: ReportStatus
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  report_count: number
  confidence: number
  is_private: boolean
  sos_session_id: string | null
  lat: number
  lng: number
}

export interface AdminCluster {
  id: string
  category: Category
  urgency: Urgency
  status: ReportStatus
  lat: number
  lng: number
  report_count: number
  reporter_count: number
  confirm_count: number
  dispute_count: number
  confidence: number
  ai_reason: string | null
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  photo_url: string | null
  attributes: AttributeMap | null
  user_urgency: UserUrgency | null
  is_private: boolean
  sos_session_id: string | null
  claimed_org_name: string | null
  created_at: string
  updated_at: string
  last_report_at: string
}

export interface AdminNotification {
  id: string
  type: string
  created_at: string
  read_at: string | null
  title_en: string | null
  title_ur: string | null
  body_en: string | null
  body_ur: string | null
  cluster_id: string | null
  report_id: string | null
  user_id: string
  user_name: string | null
  user_role: Role | null
  user_email: string | null
}

export interface AdminActivity {
  kind: string            // report | assignment_<status> | sos_<status> | org_pending | org_approved
  at: string
  ref_id: string
  cluster_id: string | null
  category: string | null // report category, or org_type for org events
  title_en: string | null
  title_ur: string | null
  status: string | null
  org_name: string | null
  is_private: boolean
  is_spam: boolean
}

/** org_directory row as an admin sees it (approved + unapproved). */
export interface AdminOrg {
  id: string
  name: string
  org_type: OrgType
  categories: Category[]
  lat: number
  lng: number
  radius_m: number | null
  approved: boolean
  owner_id: string
  phone: string | null
  created_at: string | null
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {})
  if (error) throw error
  return data as T
}

const n = (v: string | null | undefined) => (v && v !== 'all' ? v : null)

export const adminApi = {
  overview: () => rpc<AdminOverview>('admin_overview'),
  listUsers: (o: { search?: string; role?: string; limit?: number; offset?: number } = {}) =>
    rpc<Page<AdminUser>>('admin_list_users', {
      p_search: o.search || null, p_role: n(o.role), p_limit: o.limit ?? 50, p_offset: o.offset ?? 0,
    }),
  setRole: (user: string, role: Role) => rpc<{ id: string; role: Role }>('admin_set_role', { p_user: user, p_role: role }),
  setTrust: (user: string, trust: number) => rpc<{ id: string; trust_score: number }>('admin_set_trust', { p_user: user, p_trust: trust }),
  listReports: (o: { search?: string; status?: string; category?: string; includeSpam?: boolean; limit?: number; offset?: number } = {}) =>
    rpc<Page<AdminReport>>('admin_list_reports', {
      p_search: o.search || null, p_status: n(o.status), p_category: n(o.category),
      p_include_spam: o.includeSpam ?? true, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0,
    }),
  listSos: (limit = 50, offset = 0) => rpc<Page<AdminSos>>('admin_list_sos', { p_limit: limit, p_offset: offset }),
  setClusterStatus: (cluster: string, status: ReportStatus) =>
    rpc<{ id: string; status: ReportStatus }>('admin_set_cluster_status', { p_cluster: cluster, p_status: status }),
  markSpam: (report: string, spam: boolean) => rpc<{ id: string; is_spam: boolean }>('admin_mark_spam', { p_report: report, p_spam: spam }),
  listAssignments: (status?: string, limit = 300, offset = 0) =>
    rpc<Page<AdminAssignment>>('admin_list_assignments', { p_status: n(status), p_limit: limit, p_offset: offset }),
  listClusters: (includeResolved = true) => rpc<AdminCluster[]>('admin_list_clusters', { p_include_resolved: includeResolved }),
  listNotifications: (type?: string, limit = 100, offset = 0) =>
    rpc<Page<AdminNotification> & { types: Record<string, number> }>('admin_list_notifications', { p_type: n(type), p_limit: limit, p_offset: offset }),
  activity: (limit = 30) => rpc<AdminActivity[]>('admin_activity', { p_limit: limit }),
  async listOrgs(): Promise<AdminOrg[]> {
    const { data, error } = await supabase.from('org_directory').select('*').order('created_at', { ascending: false })
    if (error) throw error
    return (data as AdminOrg[] | null) ?? []
  },
  async owners(ids: string[]): Promise<Record<string, { id: string; display_name: string | null; phone: string | null }>> {
    if (!ids.length) return {}
    const { data, error } = await supabase.from('profiles').select('id, display_name, phone').in('id', ids)
    if (error) throw error
    return Object.fromEntries(((data as { id: string; display_name: string | null; phone: string | null }[] | null) ?? []).map((p) => [p.id, p]))
  },
  /** Signed URL (1 h) for a private report-audio object (voice notes, SOS chunks). Admin storage policy required. */
  async signedAudio(path: string): Promise<string> {
    const clean = path.replace(/^report-audio\//, '')
    const { data, error } = await supabase.storage.from('report-audio').createSignedUrl(clean, 3600)
    if (error) throw error
    return data.signedUrl
  },
}
