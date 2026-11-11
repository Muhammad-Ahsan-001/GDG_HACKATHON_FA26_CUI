// Onboarding state that must survive a reload (sessionStorage) + the "sent to onboarding once" flag (localStorage)
// + Pakistani mobile-number helpers. Every storage access is wrapped: private mode / blocked storage must not break the flow.
import type { Lang } from '../../lib/types'

export const ONB_STEPS = ['language', 'phone', 'sms', 'profile', 'location', 'notify', 'done'] as const
export type OnbStep = (typeof ONB_STEPS)[number]

export function stepIndex(s: OnbStep): number {
  return ONB_STEPS.indexOf(s)
}

export interface ProfileDraft { display_name: string; home_area: string; language: Lang }

export interface OnbProgress {
  step: OnbStep
  /** digits as typed, e.g. "03001234567" */
  phone: string
  /** last confirmed / extracted profile (shown again when the user comes back to the profile step) */
  draft: ProfileDraft | null
  /** complete_onboarding succeeded for `draft` */
  saved: boolean
}

const PROGRESS_KEY = 'awaaz.onb.v1'
const SEEN_PREFIX = 'awaaz.onb.seen.'

export const EMPTY_PROGRESS: OnbProgress = { step: 'language', phone: '', draft: null, saved: false }

export function loadProgress(): OnbProgress | null {
  try {
    const raw = sessionStorage.getItem(PROGRESS_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<OnbProgress>
    if (!v || typeof v !== 'object' || !ONB_STEPS.includes(v.step as OnbStep)) return null
    const d = v.draft
    const draft = d && typeof d.display_name === 'string' && typeof d.home_area === 'string' && (d.language === 'ur' || d.language === 'en')
      ? { display_name: d.display_name, home_area: d.home_area, language: d.language } : null
    return {
      step: v.step as OnbStep,
      phone: typeof v.phone === 'string' ? v.phone.replace(/\D/g, '').slice(0, 12) : '',
      draft,
      saved: Boolean(v.saved && draft),
    }
  } catch {
    return null
  }
}

export function saveProgress(p: OnbProgress): void {
  try { sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(p)) } catch { /* storage unavailable */ }
}

export function clearProgress(): void {
  try { sessionStorage.removeItem(PROGRESS_KEY) } catch { /* storage unavailable */ }
}

/** RequireAuth sends a not-yet-onboarded citizen to /onboarding only once per account on this device. */
/** In-memory copy so a device with blocked localStorage still redirects at most once per page session (no loop). */
const seenThisSession = new Set<string>()

export function onboardingSeen(uid: string): boolean {
  if (seenThisSession.has(uid)) return true
  try { return localStorage.getItem(SEEN_PREFIX + uid) === '1' } catch { return false }
}

export function markOnboardingSeen(uid: string): void {
  seenThisSession.add(uid)
  try { localStorage.setItem(SEEN_PREFIX + uid, '1') } catch { /* storage unavailable */ }
}

// ---- Pakistani mobile numbers: 03xx xxxxxxx (national) = +92 3xx xxxxxxx ----

export const DEMO_PHONE = '03001234567'
export const MAX_PHONE_DIGITS = 12 // "92" + 10 digits typed without the plus

/** National significant number ("3001234567") or null when the digits are not a Pakistani mobile number. */
function nationalPart(digits: string): string | null {
  const d = digits.replace(/\D/g, '')
  let n: string
  if (d.length === 12 && d.startsWith('92')) n = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) n = d.slice(1)
  else if (d.length === 10) n = d
  else return null
  return /^3\d{9}$/.test(n) ? n : null
}

export function isValidPhone(digits: string): boolean {
  return nationalPart(digits) !== null
}

/** E.164 form saved on the profile, e.g. "+923001234567"; null when invalid. */
export function toE164(digits: string): string | null {
  const n = nationalPart(digits)
  return n ? `+92${n}` : null
}

/** How many digits the user may type given what they typed so far. */
export function phoneMaxLength(digits: string): number {
  if (digits.startsWith('92')) return 12
  if (digits.startsWith('0')) return 11
  if (digits.startsWith('3')) return 10
  return 11
}

/** Group as the user types: "0300 1234567", "300 1234567", "92 300 1234567". */
export function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, '')
  if (d.startsWith('92')) return [d.slice(0, 2), d.slice(2, 5), d.slice(5)].filter(Boolean).join(' ')
  const head = d.startsWith('0') ? 4 : 3
  return d.length > head ? `${d.slice(0, head)} ${d.slice(head)}` : d
}

/** "+92 300 1234567" for display. */
export function formatE164(digits: string): string {
  const n = nationalPart(digits)
  return n ? `+92 ${n.slice(0, 3)} ${n.slice(3)}` : formatPhone(digits)
}

/** Random 4-digit demo code (1000-9999, no leading zero so it reads clearly). */
export function randomCode(): string {
  try {
    const b = crypto.getRandomValues(new Uint16Array(1))[0]
    return String(1000 + (b % 9000))
  } catch {
    return String(1000 + Math.floor(Math.random() * 9000))
  }
}
