// SOS session status / trigger visuals. Colours come from the shared palettes (status.ts, categories.ts,
// attributes.ts) — SOS adds no colours of its own.
import { CheckCheck, CircleSlash, Ear, Hand, ShieldCheck, Siren, Smartphone, Vibrate, Volume2, type LucideIcon } from 'lucide-react'
import { USER_URGENCY_META } from '../../lib/attributes'
import { CATEGORY_META, URGENCY_META } from '../../lib/categories'
import type { SosStatus, SosTrigger, ThreatLevel } from '../../lib/sos'
import { STATUS_META } from '../../lib/status'

export const SOS_TRIGGERS: SosTrigger[] = ['button', 'volume', 'shake', 'shortcut']

export function parseTrigger(v: string | null | undefined): SosTrigger {
  return SOS_TRIGGERS.includes(v as SosTrigger) ? (v as SosTrigger) : 'button'
}

export const SOS_STATUS_META: Record<SosStatus, { color: string; soft: string; icon: LucideIcon }> = {
  monitoring: { color: CATEGORY_META.safety.color, soft: CATEGORY_META.safety.soft, icon: Ear },
  alerted: { color: USER_URGENCY_META.emergency.color, soft: USER_URGENCY_META.emergency.soft, icon: Siren },
  safe: { color: STATUS_META.verified.color, soft: STATUS_META.verified.soft, icon: ShieldCheck },
  cancelled: { color: STATUS_META.disputed.color, soft: STATUS_META.disputed.soft, icon: CircleSlash },
  resolved: { color: STATUS_META.resolved.color, soft: STATUS_META.resolved.soft, icon: CheckCheck },
}

export const SOS_TRIGGER_ICON: Record<SosTrigger, LucideIcon> = {
  button: Hand,
  volume: Volume2,
  shake: Vibrate,
  shortcut: Smartphone,
}

export const THREAT_COLOR: Record<ThreatLevel, string> = {
  none: CATEGORY_META.safety.color,
  possible: URGENCY_META.high.color,
  high: URGENCY_META.critical.color,
}

/** Ring colours on the (light) SOS screen. */
export const SOS_RING = {
  listening: CATEGORY_META.safety.color,
  possible: URGENCY_META.high.color,
  alerted: URGENCY_META.critical.color,
  idle: CATEGORY_META.other.color,
} as const

/** The SOS button red (= critical urgency / emergency). */
export const SOS_RED = USER_URGENCY_META.emergency.color
