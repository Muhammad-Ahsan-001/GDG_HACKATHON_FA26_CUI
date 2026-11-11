// Shared Edge Function types — mirrors docs/CONTRACT.md §2. Extend, don't break.

export type Category = 'hazard' | 'fire' | 'flood' | 'water' | 'food' | 'health' | 'safety' | 'other'
export type Urgency = 'low' | 'medium' | 'high' | 'critical'
export type ReportStatus = 'unconfirmed' | 'verified' | 'disputed' | 'in_progress' | 'resolved'
export type AssignmentStatus = 'alerted' | 'claimed' | 'in_progress' | 'resolved'
export type Lang = 'ur' | 'en'
export type Provider = 'openai' | 'gemini'

export const CATEGORIES: Category[] = ['hazard', 'fire', 'flood', 'water', 'food', 'health', 'safety', 'other']
export const URGENCIES: Urgency[] = ['low', 'medium', 'high', 'critical']

export interface AiMeta { provider: Provider; model: string; fallback: boolean; ms: number }

export interface Extraction {
  category: Category
  urgency: Urgency
  title_en: string
  title_ur: string
  summary_en: string
  summary_ur: string
  /** normalised "<issue> at/near <landmark>, <area>" lowercase English, used for embeddings */
  canonical_en: string
  location_hints: string[]
  language: 'ur' | 'pa' | 'en' | 'mixed'
  is_spam: boolean
  spam_reason: string | null
  food: { food_type: string; servings_estimate: number; safe_hours: number } | null
  confidence_notes: string
}

export interface PhotoCheck {
  matches_claim: boolean
  severity: Urgency
  notes: string
  food_type: string | null
  servings_estimate: number | null
}

export interface VerificationInput {
  category: string
  urgency: string
  reports: {
    summary_en: string
    minutes_ago: number
    distance_m: number
    reporter_trust: number
    has_photo: boolean
    photo_matches: boolean | null
    modes: string[]
  }[]
  independent_reporters: number
  confirms: number
  disputes: number
  heuristic: number
}

export interface DigestPin {
  category: string
  urgency: string
  status: string
  title_en: string
  report_count: number
  minutes_ago: number
  distance_m?: number
}

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

export interface RoutedOrg { org_id: string; org_name: string; org_type: string; distance_m: number; pushed: number }

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
  routed: { org_name: string; org_type: string; distance_m: number }[]
  ai_provider: Provider
  transcript?: string
  food?: { servings: number; safe_until: string; food_type: string } | null
  rejected?: { reason: string; message_en: string; message_ur: string }
  needs_location?: { hints: string[] }
}
