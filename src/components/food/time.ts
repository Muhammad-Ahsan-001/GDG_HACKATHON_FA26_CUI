// Food rescue timing helpers: how long cooked food stays safe (clusters.safe_until) and a shared ticker so every
// countdown on screen re-renders from ONE interval per period (cheap Android phones).
import { useEffect, useState } from 'react'
import { CATEGORY_META, URGENCY_META } from '../../lib/categories'
import { STATUS_META } from '../../lib/status'

export type FoodTone = 'fresh' | 'soon' | 'urgent' | 'expired'

/** Under 60 min left → amber; under 20 min → red; past safe_until → grey "Expired". */
export const FOOD_SOON_MS = 60 * 60_000
export const FOOD_URGENT_MS = 20 * 60_000

/** Colours come from the shared category / status / urgency tables — never ad-hoc. */
export const FOOD_TONE: Record<FoodTone, { color: string; soft: string }> = {
  fresh: { color: STATUS_META.verified.color, soft: CATEGORY_META.food.soft },
  soon: { color: STATUS_META.unconfirmed.color, soft: STATUS_META.unconfirmed.soft },
  urgent: { color: URGENCY_META.critical.color, soft: CATEGORY_META.fire.soft },
  expired: { color: STATUS_META.disputed.color, soft: STATUS_META.disputed.soft },
}

/** Milliseconds until safe_until (negative once expired), or null when unknown / unparsable. */
export function foodMsLeft(safeUntil: string | null | undefined, now = Date.now()): number | null {
  if (!safeUntil) return null
  const end = new Date(safeUntil).getTime()
  return Number.isFinite(end) ? end - now : null
}

export function foodTone(msLeft: number): FoodTone {
  if (msLeft <= 0) return 'expired'
  if (msLeft < FOOD_URGENT_MS) return 'urgent'
  if (msLeft < FOOD_SOON_MS) return 'soon'
  return 'fresh'
}

/** "mm:ss" under one hour, "h:mm" otherwise. `unit` says which, so the caller can label it. */
export function formatFoodClock(msLeft: number): { clock: string; unit: 'min' | 'hours' } {
  const s = Math.max(0, Math.floor(msLeft / 1000))
  if (s < 3600) {
    return { clock: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, unit: 'min' }
  }
  const totalMin = Math.floor(s / 60)
  return { clock: `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`, unit: 'hours' }
}

/**
 * Sort helper for lists of food items: soonest-to-expire first, expired and unknown last.
 * (The dashboard owns its own sorting — this is exposed for it to reuse.)
 */
export function compareFoodExpiry(a: string | null | undefined, b: string | null | undefined, now = Date.now()): number {
  const la = foodMsLeft(a, now)
  const lb = foodMsLeft(b, now)
  const rank = (l: number | null) => (l === null ? Number.POSITIVE_INFINITY : l <= 0 ? Number.MAX_SAFE_INTEGER + l : l)
  return rank(la) - rank(lb)
}

// ---------------------------------------------------------------- shared ticker
const tickers = new Map<number, { listeners: Set<() => void>; timer: number }>()

/** Current time, re-rendered every `periodMs`; all users of the same period share one interval. */
export function useTicker(periodMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    let entry = tickers.get(periodMs)
    if (!entry) {
      const listeners = new Set<() => void>()
      const timer = window.setInterval(() => { for (const l of listeners) l() }, periodMs)
      entry = { listeners, timer }
      tickers.set(periodMs, entry)
    }
    const mine = entry
    const listener = () => setNow(Date.now())
    mine.listeners.add(listener)
    listener()
    return () => {
      mine.listeners.delete(listener)
      if (mine.listeners.size === 0) {
        window.clearInterval(mine.timer)
        tickers.delete(periodMs)
      }
    }
  }, [periodMs, enabled])
  return now
}

/** LRI … PDI: keeps an LTR clock ("12:05") intact inside Urdu (RTL) text. */
export const isolateLtr = (s: string) => `${String.fromCharCode(0x2066)}${s}${String.fromCharCode(0x2069)}`
