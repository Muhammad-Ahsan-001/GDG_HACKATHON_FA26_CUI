// Seeded demo accounts (created by scripts/seed.mjs). Shared demo password for judges — demo data only.
import type { Role } from './types'

export const DEMO_PASSWORD = 'AwaazDemo#2026'

export interface DemoAccount { email: string; role: Role; label_en: string; label_ur: string }

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'citizen1@awaaz.demo', role: 'citizen', label_en: 'Citizen (Ayesha)', label_ur: 'شہری (عائشہ)' },
  { email: 'citizen2@awaaz.demo', role: 'citizen', label_en: 'Citizen (Bilal)', label_ur: 'شہری (بلال)' },
  { email: 'rescue1122@awaaz.demo', role: 'responder', label_en: 'Rescue 1122', label_ur: 'ریسکیو 1122' },
  { email: 'fire@awaaz.demo', role: 'responder', label_en: 'Fire Brigade', label_ur: 'فائر بریگیڈ' },
  { email: 'police@awaaz.demo', role: 'responder', label_en: 'Police', label_ur: 'پولیس' },
  { email: 'water@awaaz.demo', role: 'responder', label_en: 'Water Authority (WASA)', label_ur: 'واسا' },
  { email: 'shelter@awaaz.demo', role: 'ngo', label_en: 'Shelter NGO', label_ur: 'پناہ گاہ' },
  { email: 'foodbank@awaaz.demo', role: 'ngo', label_en: 'Food Bank NGO', label_ur: 'فوڈ بینک' },
  { email: 'health@awaaz.demo', role: 'ngo', label_en: 'Health NGO', label_ur: 'صحت تنظیم' },
  { email: 'admin@awaaz.demo', role: 'admin', label_en: 'Admin', label_ur: 'ایڈمن' },
]
// citizen3..citizen5@awaaz.demo also exist (seed data reporters).
