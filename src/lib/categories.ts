import {
  CircleHelp, Droplets, Flame, HeartPulse, ShieldAlert, TriangleAlert, Utensils, Waves,
  type LucideIcon,
} from 'lucide-react'
import type { Category, Urgency } from './types'

export interface CategoryMeta {
  color: string      // pin fill
  soft: string       // light background
  icon: LucideIcon
  en: string
  ur: string
}

/** Single source of truth for category colour + icon. Never hard-code these elsewhere. */
export const CATEGORY_META: Record<Category, CategoryMeta> = {
  hazard: { color: '#EA580C', soft: '#FFEDD5', icon: TriangleAlert, en: 'Hazard', ur: 'خطرہ' },
  fire:   { color: '#DC2626', soft: '#FEE2E2', icon: Flame,         en: 'Fire',   ur: 'آگ' },
  flood:  { color: '#2563EB', soft: '#DBEAFE', icon: Waves,         en: 'Flood',  ur: 'سیلاب' },
  water:  { color: '#0891B2', soft: '#CFFAFE', icon: Droplets,      en: 'Water',  ur: 'پانی' },
  food:   { color: '#16A34A', soft: '#DCFCE7', icon: Utensils,      en: 'Food',   ur: 'کھانا' },
  health: { color: '#DB2777', soft: '#FCE7F3', icon: HeartPulse,    en: 'Health', ur: 'صحت' },
  safety: { color: '#7C3AED', soft: '#EDE9FE', icon: ShieldAlert,   en: 'Safety', ur: 'حفاظت' },
  other:  { color: '#475569', soft: '#F1F5F9', icon: CircleHelp,    en: 'Other',  ur: 'دیگر' },
}

export const URGENCY_META: Record<Urgency, { color: string; en: string; ur: string; rank: number }> = {
  low:      { color: '#64748B', en: 'Low',      ur: 'کم',       rank: 0 },
  medium:   { color: '#CA8A04', en: 'Medium',   ur: 'درمیانہ',  rank: 1 },
  high:     { color: '#EA580C', en: 'High',     ur: 'زیادہ',    rank: 2 },
  critical: { color: '#DC2626', en: 'Critical', ur: 'انتہائی',  rank: 3 },
}
