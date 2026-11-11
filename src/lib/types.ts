// Shared frontend types. Mirrors docs/CONTRACT.md. Extend, don't break.

export type Role = 'citizen' | 'ngo' | 'responder' | 'admin'
export type OrgType = 'shelter' | 'food_bank' | 'health_ngo' | 'rescue_1122' | 'fire' | 'police' | 'water'
export type Category = 'hazard' | 'fire' | 'flood' | 'water' | 'food' | 'health' | 'safety' | 'other'
export type Urgency = 'low' | 'medium' | 'high' | 'critical'
export type ReportStatus = 'unconfirmed' | 'verified' | 'disputed' | 'in_progress' | 'resolved'
export type AssignmentStatus = 'alerted' | 'claimed' | 'in_progress' | 'resolved'
export type VoteType = 'confirm' | 'dispute'
export type Lang = 'ur' | 'en'

export const CATEGORIES: Category[] = ['hazard', 'fire', 'flood', 'water', 'food', 'health', 'safety', 'other']
export const URGENCIES: Urgency[] = ['low', 'medium', 'high', 'critical']
export const NGO_ORG_TYPES: OrgType[] = ['shelter', 'food_bank', 'health_ngo']
export const RESPONDER_ORG_TYPES: OrgType[] = ['rescue_1122', 'fire', 'police', 'water']

export interface Profile {
  id: string
  role: Role
  display_name: string | null
  phone: string | null
  language: Lang
  trust_score: number
  is_demo: boolean
  created_at: string
}

/** Row of the `map_pins` view (one per cluster). */
export interface MapPin {
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
  food_servings: number | null
  food_type: string | null
  safe_until: string | null
  claimed_org_name: string | null
  created_at: string
  updated_at: string
  last_report_at: string
}

/** Row of the `public_reports` view. */
export interface PublicReport {
  id: string
  cluster_id: string
  category: Category
  urgency: Urgency
  status: ReportStatus
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  language: string | null
  input_modes: string[]
  has_photo: boolean
  photo_url: string | null
  created_at: string
  is_mine: boolean
}

/** Own report row (RLS: reporter only). */
export interface MyReport extends Omit<PublicReport, 'is_mine' | 'has_photo' | 'photo_url'> {
  transcript: string | null
  address_text: string | null
  confidence: number
  ai_reason: string | null
  is_spam: boolean
  food_servings: number | null
  safe_until: string | null
}

export interface Organization {
  id: string
  name: string
  org_type: OrgType
  categories: Category[]
  lat: number
  lng: number
  radius_m: number | null
  approved?: boolean
}

/** Row of `my_assignments` (responder / NGO dashboard). */
export interface MyAssignment {
  assignment_id: string
  org_id: string
  org_name: string
  org_type: OrgType
  status: AssignmentStatus
  distance_m: number | null
  note: string | null
  alerted_at: string
  claimed_at: string | null
  in_progress_at: string | null
  resolved_at: string | null
  cluster_id: string
  category: Category
  urgency: Urgency
  cluster_status: ReportStatus
  lat: number
  lng: number
  report_count: number
  confidence: number
  ai_reason: string | null
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  photo_url: string | null
  food_servings: number | null
  food_type: string | null
  safe_until: string | null
}

export interface AppNotification {
  id: string
  user_id: string
  report_id: string | null
  cluster_id: string | null
  type: 'new_assignment' | 'status_change' | 'nearby_alert' | 'food_alert' | 'verified' | string
  title_en: string | null
  title_ur: string | null
  body_en: string | null
  body_ur: string | null
  data: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}

// ---- Edge Function contracts ----
export interface ProcessReportRequest {
  client_id: string
  text?: string
  audio_path?: string
  image_paths?: string[]
  lat?: number
  lng?: number
  accuracy_m?: number
  location_source?: 'gps' | 'map' | 'geocoded'
  address_text?: string
  language?: 'ur' | 'en' | 'pa' | 'auto'
  ui_language: Lang
  category_hint?: Category
}

export interface ProcessReportResponse {
  report_id: string
  cluster_id: string | null
  is_duplicate: boolean
  similarity: number | null
  status: ReportStatus
  confidence: number
  category: Category
  urgency: Urgency
  title_en: string
  title_ur: string
  summary_en: string
  summary_ur: string
  ai_reason: string | null
  routed: { org_name: string; org_type: OrgType; distance_m: number }[]
  ai_provider: 'openai' | 'gemini'
  transcript?: string
  food?: { servings: number; safe_until: string; food_type: string } | null
  rejected?: { reason: string; message_en: string; message_ur: string }
  needs_location?: { hints: string[] }
}

export interface VoteResponse {
  status: ReportStatus
  confidence: number
  confirm_count: number
  dispute_count: number
  ai_reason: string | null
}

export interface AssignmentActionResponse {
  assignment_id: string
  status: AssignmentStatus
  cluster_status: ReportStatus
}

export interface DigestResponse {
  en: string
  ur: string
  provider: 'openai' | 'gemini'
  generated_at: string
  pin_count: number
  /** false for the "all quiet" message and the fixed-wording fallback (show <AiLabel/> only when true) */
  ai?: boolean
}
