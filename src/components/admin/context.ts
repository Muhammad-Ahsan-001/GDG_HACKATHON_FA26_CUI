import { createContext, useContext, useEffect, useRef, useState, useCallback, type DependencyList } from 'react'
import type { AdminOverview } from '../../lib/adminApi'

export type Section = 'overview' | 'map' | 'reports' | 'users' | 'orgs' | 'assignments' | 'sos' | 'notifications'
export const SECTIONS: Section[] = ['overview', 'map', 'reports', 'users', 'orgs', 'assignments', 'sos', 'notifications']
export type LiveState = 'live' | 'connecting' | 'offline'

export interface AdminCtx {
  section: Section
  go: (s: Section, opts?: { search?: string }) => void
  live: LiveState
  /** bumps (debounced) on every realtime change + every minute; panels refetch when it changes */
  version: number
  refresh: () => void
  search: string
  setSearch: (s: string) => void
  overview: AdminOverview | null
  overviewError: unknown
  toast: (msg: string, tone?: 'ok' | 'error') => void
  /** ids that changed in the last realtime burst (rows flash briefly) */
  changed: Set<string>
}

export const AdminContext = createContext<AdminCtx | null>(null)

export function useAdmin(): AdminCtx {
  const v = useContext(AdminContext)
  if (!v) throw new Error('useAdmin outside <AdminContext>')
  return v
}

/**
 * Load data and reload on `deps` change. Keeps the previous data while reloading (no layout jump),
 * so realtime refreshes are silent; `loading` is true only before the first result.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(() => {
    const my = ++seq.current
    setBusy(true)
    fnRef.current().then(
      (d) => { if (my === seq.current) { setData(d); setError(null); setLoading(false); setBusy(false) } },
      (e: unknown) => { if (my === seq.current) { setError(e); setLoading(false); setBusy(false) } },
    )
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-provided deps
  useEffect(() => { run() }, deps)

  return { data, setData, error, loading, busy, reload: run }
}

/** Format minutes as "42 min" / "1 h 12 min". */
export function fmtMinutes(t: (k: string, v?: Record<string, string | number>) => string, mins: number | null | undefined): string | null {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return null
  const m = Math.round(mins)
  if (m < 60) return t('admin.min', { n: m })
  return t('admin.hmin', { h: Math.floor(m / 60), m: m % 60 })
}

export function fmtDuration(fromIso: string, toIso?: string | null): string {
  const ms = Math.max(0, (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime())
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

const LRI = String.fromCharCode(0x2066)
const PDI = String.fromCharCode(0x2069)
/** Absolute date-time, isolated LTR so it reads right inside Urdu text. */
export function fmtDateTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return LRI + d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
  }) + PDI
}
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return LRI + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + PDI
}
export const ltr = (s: string | number) => LRI + String(s) + PDI
