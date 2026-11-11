// Report attributes gathered by the AI intake conversation (default catalog + AI-generated extras).
// Mirrors supabase/functions/_shared/attributes.ts — keep both in sync.
import {
  Baby, Bandage, Car, Clock, Construction, Droplets, Eye, Flame, HeartPulse, Info, MapPin, Repeat,
  ShieldAlert, Siren, Thermometer, TriangleAlert, Users, Utensils, Waves, Zap, type LucideIcon,
} from 'lucide-react'

/** Icon names the AI may use (server validates against the same list). */
export const ATTRIBUTE_ICONS: Record<string, LucideIcon> = {
  siren: Siren, 'alert-triangle': TriangleAlert, users: Users, bandage: Bandage, baby: Baby, clock: Clock,
  repeat: Repeat, construction: Construction, 'map-pin': MapPin, flame: Flame, droplets: Droplets, waves: Waves,
  utensils: Utensils, 'heart-pulse': HeartPulse, 'shield-alert': ShieldAlert, car: Car, zap: Zap,
  thermometer: Thermometer, eye: Eye, info: Info,
}
export type AttributeIcon = keyof typeof ATTRIBUTE_ICONS

export interface ReportAttribute {
  key: string                 // snake_case, e.g. "people_affected", or AI-generated e.g. "water_depth"
  label_en: string
  label_ur: string
  value_en: string            // human-readable value, e.g. "3 people", "Knee deep"
  value_ur: string
  icon: AttributeIcon | string
  severity: 'info' | 'warn' | 'danger'
  source: 'user' | 'ai'       // user tapped/said it vs AI inferred it
}
export type AttributeMap = Record<string, ReportAttribute>

export type UserUrgency = 'emergency' | 'urgent' | 'can_wait'

/** Default attribute catalog the intake AI tries to fill (category-specific extras are AI-generated). */
export const DEFAULT_ATTRIBUTES: { key: string; icon: AttributeIcon; label_en: string; label_ur: string }[] = [
  { key: 'user_urgency', icon: 'siren', label_en: 'How urgent', label_ur: 'کتنا ضروری' },
  { key: 'people_affected', icon: 'users', label_en: 'People affected', label_ur: 'متاثرہ لوگ' },
  { key: 'injuries', icon: 'bandage', label_en: 'Anyone hurt', label_ur: 'کوئی زخمی' },
  { key: 'children_at_risk', icon: 'baby', label_en: 'Children at risk', label_ur: 'بچوں کو خطرہ' },
  { key: 'since_when', icon: 'clock', label_en: 'Since when', label_ur: 'کب سے' },
  { key: 'still_happening', icon: 'eye', label_en: 'Still happening', label_ur: 'ابھی بھی جاری' },
  { key: 'road_blocked', icon: 'construction', label_en: 'Road blocked', label_ur: 'راستہ بند' },
  { key: 'landmark', icon: 'map-pin', label_en: 'Nearby landmark', label_ur: 'قریبی نشانی' },
  { key: 'recurring', icon: 'repeat', label_en: 'Happened before', label_ur: 'پہلے بھی ہوا' },
]

export const USER_URGENCY_META: Record<UserUrgency, { color: string; soft: string; icon: LucideIcon; en: string; ur: string }> = {
  emergency: { color: '#DC2626', soft: '#FEE2E2', icon: Siren, en: 'Emergency', ur: 'ایمرجنسی' },
  urgent: { color: '#EA580C', soft: '#FFEDD5', icon: TriangleAlert, en: 'Urgent', ur: 'فوری' },
  can_wait: { color: '#0F766E', soft: '#CCFBF1', icon: Clock, en: 'Can wait', ur: 'انتظار ہو سکتا ہے' },
}

export function attributeIcon(name: string | undefined): LucideIcon {
  return (name && ATTRIBUTE_ICONS[name]) || Info
}

/** Order for display: danger first, then the default catalog order, then AI extras. */
export function sortAttributes(attrs: AttributeMap | null | undefined): ReportAttribute[] {
  if (!attrs) return []
  const order = new Map(DEFAULT_ATTRIBUTES.map((a, i) => [a.key, i]))
  const sev = { danger: 0, warn: 1, info: 2 } as const
  return Object.values(attrs)
    .filter((a) => a && a.value_en)
    .sort((a, b) => (sev[a.severity] ?? 2) - (sev[b.severity] ?? 2) || (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
}

// ---- intake conversation (report-chat Edge Function) ----
export interface ChatTurn {
  role: 'user' | 'ai'
  text: string                  // user: transcript or typed text; ai: question in the UI language
  text_alt?: string             // ai: same question in the other language
  at: string                    // ISO time
  audio_path?: string           // user voice turn (report-audio bucket)
  audio_url?: string            // ai: TTS clip
}

export interface QuickReply {
  key: string                   // attribute key it answers
  value: string                 // machine value, e.g. "yes", "emergency", "3"
  label_en: string
  label_ur: string
  icon: string                  // ATTRIBUTE_ICONS name
}

export interface IntakeDraft {
  category: string
  urgency: 'low' | 'medium' | 'high' | 'critical'
  title_en: string
  title_ur: string
  summary_en: string
  summary_ur: string
}

export interface ReportChatRequest {
  session_id: string
  ui_language: 'ur' | 'en'
  history: ChatTurn[]           // full conversation so far (client keeps it)
  attributes: AttributeMap      // accumulated so far
  audio_path?: string           // this user turn as voice
  text?: string                 // this user turn as text
  quick_reply?: { key: string; value: string }  // this user turn as a tapped chip
  image_paths?: string[]        // photos attached so far (report-images)
  lat?: number
  lng?: number
}

export interface ReportChatResponse {
  turn: number                  // AI questions asked so far (max 3)
  transcript?: string           // what we heard this turn
  no_speech?: boolean           // silence / unintelligible: reply asks to repeat, turn not counted
  reply: { en: string; ur: string }
  reply_audio_url?: string      // TTS of reply in ui_language
  quick_replies: QuickReply[]
  attributes: AttributeMap      // full updated set
  draft: IntakeDraft
  ready: boolean                // enough to submit (or max questions reached)
  emergency: boolean            // submit immediately
  ask_photo: boolean            // a photo would help
}
