// Typed wrappers for every Edge Function + RPC. Pages/components call these, never fetch directly.
import { supabase } from './supabase'
import type { ReportChatRequest, ReportChatResponse } from './attributes'
import type { SosRequest, SosResponse } from './sos'

export interface VoiceProfileResponse {
  transcript: string
  no_speech: boolean
  profile: { display_name: string | null; home_area: string | null; language: Lang | null }
  confirm: { en: string; ur: string }
  confirm_audio_url?: string
}
import type {
  AssignmentActionResponse, Category, DigestResponse, Lang, OrgType, ProcessReportRequest,
  ProcessReportResponse, Role, VoteResponse, VoteType,
} from './types'

export class ApiError extends Error {
  status: number
  code?: string
  body?: unknown
  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
  }
}

/** Invoke an Edge Function with the current session; throws ApiError with the server's {error, code}. */
export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> })
  if (error) {
    // FunctionsHttpError carries the Response in `context`
    const ctx = (error as { context?: Response }).context
    let parsed: { error?: string; code?: string } | undefined
    let status = 500
    if (ctx && typeof ctx.json === 'function') {
      status = ctx.status
      try { parsed = await ctx.clone().json() } catch { /* not json */ }
    }
    throw new ApiError(parsed?.error || error.message, status, parsed?.code, parsed)
  }
  return data as T
}

export const api = {
  // ---- Phase 1b: AI intake conversation, voice onboarding, SOS ----
  reportChat: (req: ReportChatRequest) => callFunction<ReportChatResponse>('report-chat', req),
  voiceProfile: (req: { audio_path?: string; text?: string; ui_language: Lang }) =>
    callFunction<VoiceProfileResponse>('voice-profile', req),
  async completeOnboarding(input: { display_name: string; home_area: string; language: Lang; phone?: string | null }) {
    const { data, error } = await supabase.rpc('complete_onboarding', {
      p_display_name: input.display_name, p_home_area: input.home_area, p_language: input.language, p_phone: input.phone ?? null,
    })
    if (error) throw error
    return data
  },
  sos: (req: SosRequest) => callFunction<SosResponse>('sos', req),

  processReport: (req: ProcessReportRequest) => callFunction<ProcessReportResponse>('process-report', req),
  vote: (cluster_id: string, vote: VoteType) => callFunction<VoteResponse>('vote', { cluster_id, vote }),
  assignmentAction: (assignment_id: string, action: 'claim' | 'start' | 'resolve', note?: string) =>
    callFunction<AssignmentActionResponse>('assignment-action', { assignment_id, action, note }),
  tts: (text: string, lang: Lang) => callFunction<{ url: string; cached: boolean }>('tts', { text, lang }),
  digestNearby: (lat: number, lng: number, radius_m = 3000) =>
    callFunction<DigestResponse>('digest', { mode: 'nearby', lat, lng, radius_m }),
  digestDaily: (org_id?: string) => callFunction<DigestResponse>('digest', { mode: 'daily', org_id }),

  // ---- RPCs ----
  async setMyRole(role: Exclude<Role, 'admin'>) {
    const { error } = await supabase.rpc('set_my_role', { p_role: role })
    if (error) throw error
  },
  async updateMyLocation(lat: number, lng: number) {
    const { error } = await supabase.rpc('update_my_location', { p_lat: lat, p_lng: lng })
    if (error) throw error
  },
  async registerOrganization(input: {
    name: string; org_type: OrgType; categories: Category[]; lat: number; lng: number; radius_m: number; phone?: string
  }): Promise<string> {
    const { data, error } = await supabase.rpc('register_organization', {
      p_name: input.name, p_org_type: input.org_type, p_categories: input.categories,
      p_lat: input.lat, p_lng: input.lng, p_radius_m: input.radius_m, p_phone: input.phone ?? null,
    })
    if (error) throw error
    return data as string
  },
  async approveOrganization(org_id: string, approved: boolean) {
    const { error } = await supabase.rpc('approve_organization', { p_org_id: org_id, p_approved: approved })
    if (error) throw error
  },
  async dashboardStats(org_id?: string) {
    const { data, error } = await supabase.rpc('dashboard_stats', { p_org_id: org_id ?? null })
    if (error) throw error
    return data as {
      open: number; claimed: number; in_progress: number; resolved_today: number
      avg_minutes_to_claim: number | null; by_category: Partial<Record<Category, number>>
    }
  },
}
