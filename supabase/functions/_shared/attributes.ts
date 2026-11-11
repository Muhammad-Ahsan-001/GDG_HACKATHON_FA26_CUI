// Report attributes (server mirror of src/lib/attributes.ts — keep both in sync).

export const ATTRIBUTE_ICON_NAMES = [
  'siren', 'alert-triangle', 'users', 'bandage', 'baby', 'clock', 'repeat', 'construction', 'map-pin', 'flame',
  'droplets', 'waves', 'utensils', 'heart-pulse', 'shield-alert', 'car', 'zap', 'thermometer', 'eye', 'info',
] as const

export interface ReportAttribute {
  key: string
  label_en: string
  label_ur: string
  value_en: string
  value_ur: string
  icon: string
  severity: 'info' | 'warn' | 'danger'
  source: 'user' | 'ai'
}
export type AttributeMap = Record<string, ReportAttribute>
export type UserUrgency = 'emergency' | 'urgent' | 'can_wait'

export const DEFAULT_ATTRIBUTES = [
  { key: 'user_urgency', icon: 'siren', label_en: 'How urgent', label_ur: 'کتنا ضروری' },
  { key: 'people_affected', icon: 'users', label_en: 'People affected', label_ur: 'متاثرہ لوگ' },
  { key: 'injuries', icon: 'bandage', label_en: 'Anyone hurt', label_ur: 'کوئی زخمی' },
  { key: 'children_at_risk', icon: 'baby', label_en: 'Children at risk', label_ur: 'بچوں کو خطرہ' },
  { key: 'since_when', icon: 'clock', label_en: 'Since when', label_ur: 'کب سے' },
  { key: 'still_happening', icon: 'eye', label_en: 'Still happening', label_ur: 'ابھی بھی جاری' },
  { key: 'road_blocked', icon: 'construction', label_en: 'Road blocked', label_ur: 'راستہ بند' },
  { key: 'landmark', icon: 'map-pin', label_en: 'Nearby landmark', label_ur: 'قریبی نشانی' },
  { key: 'recurring', icon: 'repeat', label_en: 'Happened before', label_ur: 'پہلے بھی ہوا' },
] as const

/** Category-specific attributes the intake AI should consider (it may invent others in the same shape). */
export const CATEGORY_ATTRIBUTE_HINTS: Record<string, string[]> = {
  hazard: ['hazard_type (open manhole / live wire / broken road / collapsed wall / signal)', 'size_or_depth', 'marked_or_covered'],
  fire: ['people_trapped', 'smoke_or_flames', 'building_type', 'gas_cylinder_nearby'],
  flood: ['water_depth (ankle / knee / waist / above)', 'water_rising', 'houses_flooded', 'stranded_people'],
  water: ['supply_off_hours', 'contamination (colour / smell)', 'leak_size', 'households_affected'],
  food: ['food_type', 'servings', 'safe_until / cooked_at', 'pickup_window', 'packaging_available'],
  health: ['conscious', 'breathing', 'age_group', 'bleeding', 'ambulance_called'],
  safety: ['ongoing_threat', 'weapon_seen', 'suspect_description', 'victims'],
  other: [],
}

export const MAX_INTAKE_QUESTIONS = 3

export function sanitizeAttributes(input: unknown): AttributeMap {
  const out: AttributeMap = {}
  if (!input || typeof input !== 'object') return out
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Partial<ReportAttribute>
    const key = String(a.key ?? k).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)
    if (!key || !a.value_en) continue
    out[key] = {
      key,
      label_en: String(a.label_en ?? key).slice(0, 60),
      label_ur: String(a.label_ur ?? a.label_en ?? key).slice(0, 60),
      value_en: String(a.value_en).slice(0, 120),
      value_ur: String(a.value_ur ?? a.value_en).slice(0, 120),
      icon: (ATTRIBUTE_ICON_NAMES as readonly string[]).includes(String(a.icon)) ? String(a.icon) : 'info',
      severity: a.severity === 'danger' || a.severity === 'warn' ? a.severity : 'info',
      source: a.source === 'user' ? 'user' : 'ai',
    }
    if (Object.keys(out).length >= 20) break
  }
  return out
}
