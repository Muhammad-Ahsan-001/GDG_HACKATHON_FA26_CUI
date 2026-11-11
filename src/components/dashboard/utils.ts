import { useEffect, useState } from 'react'
import { URGENCY_META } from '../../lib/categories'
import type { DashAssignment, DashTab } from './types'

type T = (key: string, vars?: Record<string, string | number>) => string

const ts = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0)

/**
 * List order. New/Active: critical, then high, then everything else — newest first inside each group.
 * Done: most recently resolved first.
 */
export function sortForTab(list: DashAssignment[], tab: DashTab): DashAssignment[] {
  const prio = (a: DashAssignment) => {
    const r = URGENCY_META[a.urgency]?.rank ?? 1
    return r >= 2 ? r : 0
  }
  return [...list].sort((a, b) => {
    if (tab === 'done') return ts(b.resolved_at ?? b.alerted_at) - ts(a.resolved_at ?? a.alerted_at)
    return prio(b) - prio(a) || ts(b.alerted_at) - ts(a.alerted_at)
  })
}

// ---------------------------------------------------------------------------
// Shared tickers: one setInterval per period for the whole page (cheap phones).
// ---------------------------------------------------------------------------
const tickers = new Map<number, { listeners: Set<() => void>; timer: number }>()

/** Current time, re-rendering every `periodMs`. All components using the same period share one timer. */
export function useNow(periodMs: number, enabled = true): number {
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

/** `window.matchMedia` as state. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

// ---------------------------------------------------------------------------
// Formatters (all text through t())
// ---------------------------------------------------------------------------

/** Human duration: "12 min", "2 h 5 min", "1 d 3 h". */
export function formatDuration(ms: number, t: T): string {
  const totalMin = Math.max(0, Math.round(ms / 60000))
  if (totalMin < 60) return t('dashboard.durMin', { m: totalMin })
  const totalH = Math.floor(totalMin / 60)
  if (totalH < 24) return t('dashboard.durHourMin', { h: totalH, m: totalMin % 60 })
  return t('dashboard.durDayHour', { d: Math.floor(totalH / 24), h: totalH % 24 })
}

/** Countdown: "2 h 14 min" when >= 1 h, otherwise a ticking "mm:ss". */
export function formatCountdown(ms: number, t: T): string {
  if (ms >= 3600_000) return formatDuration(ms, t)
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** Distance in km with one decimal ("0.4 km", "3.2 km"). */
export function formatKm(m: number | null | undefined, t: T): string | null {
  if (m == null || !Number.isFinite(m)) return null
  const km = m / 1000
  return t('common.km', { n: km < 10 ? km.toFixed(1) : Math.round(km) })
}

/** Google Maps directions link to a point (opens the Maps app on phones). */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`
}

export function readLocal(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

export function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}
