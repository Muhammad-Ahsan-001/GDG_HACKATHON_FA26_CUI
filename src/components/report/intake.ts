// Intake-conversation model shared by the report sheet components (UI messages, helpers, error mapping).
import { ApiError } from '../../lib/api'
import {
  USER_URGENCY_META, type AttributeMap, type QuickReply, type ReportAttribute, type UserUrgency,
} from '../../lib/attributes'
import { MediaUploadError } from '../../lib/media'
import { CATEGORIES, type Category } from '../../lib/types'
import type { VoicePromptId } from '../../lib/voice/player'

/** One bubble in the conversation. `history` (what the server sees) is kept separately as ChatTurn[]. */
export type Msg =
  | {
    id: string
    role: 'ai'
    /** greeting / photo hint = local text with a pre-recorded clip; reply = report-chat; unheard = no_speech reply */
    kind: 'greeting' | 'photo_hint' | 'reply' | 'unheard'
    en: string
    ur: string
    audioUrl?: string
    /** pre-recorded clip to replay (local bubbles) */
    prompt?: VoicePromptId
  }
  | {
    id: string
    role: 'user'
    kind: 'voice' | 'text' | 'chip' | 'photo'
    status: 'sending' | 'done' | 'failed' | 'unheard'
    text?: string
    durationMs?: number
    chip?: QuickReply
    photoIds?: string[]
  }

export type ErrKind = 'offline' | 'network' | 'server' | 'upload' | 'auth'

export function classifyError(e: unknown): ErrKind {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  if (e instanceof MediaUploadError) return e.code === 'network' ? 'network' : e.code === 'auth' ? 'auth' : 'upload'
  if (e instanceof ApiError) {
    if (e.status === 401) return 'auth'
    // FunctionsFetchError / FunctionsRelayError: no HTTP response body reached us
    if (e.body === undefined && /send a request|fetch|network|relay|load failed/i.test(e.message)) return 'network'
    return 'server'
  }
  if (e instanceof TypeError) return 'network'
  return 'server'
}

export function hintsFromBody(body: unknown): string[] {
  const b = body as { needs_location?: { hints?: unknown }; hints?: unknown } | undefined
  const h = b?.needs_location?.hints ?? b?.hints
  return Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : []
}

const URGENCY_ICON: Record<UserUrgency, string> = { emergency: 'siren', urgent: 'alert-triangle', can_wait: 'clock' }
const URGENCY_SEVERITY: Record<UserUrgency, ReportAttribute['severity']> = { emergency: 'danger', urgent: 'warn', can_wait: 'info' }

/** The `user_urgency` attribute as the user chose it (source 'user'). */
export function urgencyAttribute(u: UserUrgency): ReportAttribute {
  const m = USER_URGENCY_META[u]
  return {
    key: 'user_urgency', label_en: 'How urgent', label_ur: 'کتنا ضروری', value_en: m.en, value_ur: m.ur,
    icon: URGENCY_ICON[u], severity: URGENCY_SEVERITY[u], source: 'user',
  }
}

export function isUserUrgency(v: unknown): v is UserUrgency {
  return v === 'emergency' || v === 'urgent' || v === 'can_wait'
}

/** Read the user's urgency back from an attribute map (e.g. the AI recorded what the user said). */
export function urgencyFromAttributes(a: AttributeMap): UserUrgency | null {
  const at = a.user_urgency
  if (!at || at.source !== 'user') return null
  const v = `${at.value_en} ${at.key}`.toLowerCase()
  if (/emergenc/.test(v)) return 'emergency'
  if (/can.?wait|wait|later|not urgent/.test(v)) return 'can_wait'
  if (/urgent/.test(v)) return 'urgent'
  return null
}

/** A quick reply that answers "Sending now?" with yes (report-chat offers it when `ready`). */
export function isSendChip(q: QuickReply): boolean {
  const key = q.key.toLowerCase()
  const value = q.value.toLowerCase()
  if (/^(send|submit|send_now)$/.test(value)) return true
  return /^(confirm|send|submit|send_now|ready|confirm_send)$/.test(key) && /^(yes|ok|true|send|confirm|1)$/.test(value)
}

/** The user said "no / something else" to the confirmation: keep talking. */
export function isMoreChip(q: QuickReply): boolean {
  return /^(confirm|send|submit|ready|confirm_send)$/.test(q.key.toLowerCase()) && !isSendChip(q)
}

export function asCategory(c: string | undefined | null): Category | undefined {
  return c && (CATEGORIES as string[]).includes(c) ? (c as Category) : undefined
}

let seq = 0
export const msgId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
