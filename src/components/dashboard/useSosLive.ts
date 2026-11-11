// Live state of the SOS sessions behind the dashboard's SOS alerts: status, threat, and the moving location.
// Reads `sos_sessions_view` (security_invoker: police see only sessions of clusters assigned to their org) and
// follows Realtime UPDATEs on `public.sos_sessions` (the geography column comes as WKB, so changed rows are
// refetched from the view). Falls back to polling while Realtime is down.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SosStatus, SosTrigger, ThreatLevel } from '../../lib/sos'
import { supabase } from '../../lib/supabase'
import type { DashAssignment } from './types'

export interface SosLive {
  id: string
  status: SosStatus
  trigger: SosTrigger
  threat_level: ThreatLevel
  threat_reason: string | null
  alerted_at: string | null
  ended_at: string | null
  started_at: string | null
  lat: number | null
  lng: number | null
  last_location_at: string | null
  last_accuracy_m: number | null
  updated_at: string | null
  /** positions received while this dashboard was open, oldest first (for the trail on the map) */
  trail: [number, number][]
}

type Row = Omit<SosLive, 'trail'>

const COLS = 'id, status, trigger, threat_level, threat_reason, alerted_at, ended_at, started_at, lat, lng, last_location_at, last_accuracy_m, updated_at'
const DEBOUNCE_MS = 250
const POLL_MS = 15_000
const MAX_TRAIL = 60

/** An SOS (women's safety) alert: a private cluster created by the sos Edge Function. */
export function isSos(a: Pick<DashAssignment, 'sos_session_id' | 'is_private'>): boolean {
  return Boolean(a.sos_session_id || a.is_private)
}

/** Has the session reported a position within `ms`? */
export function isLocationFresh(live: SosLive | undefined, now: number, ms = 90_000): boolean {
  if (!live?.last_location_at || live.lat == null) return false
  return now - new Date(live.last_location_at).getTime() < ms
}

function merge(prev: SosLive | undefined, row: Row): SosLive {
  if (prev && sameRow(prev, row)) return prev
  const trail = prev ? prev.trail : []
  if (row.lat == null || row.lng == null) return { ...row, trail }
  const last = trail[trail.length - 1]
  if (last && last[0] === row.lat && last[1] === row.lng) return { ...row, trail }
  const next = [...trail, [row.lat, row.lng] as [number, number]]
  return { ...row, trail: next.length > MAX_TRAIL ? next.slice(next.length - MAX_TRAIL) : next }
}

function sameRow(a: SosLive, b: Row): boolean {
  return (Object.keys(b) as (keyof Row)[]).every((k) => a[k] === b[k])
}

/** `sessionIds`: the sessions to follow (active SOS alerts). Returns session id → live state. */
export function useSosLive(sessionIds: readonly string[]): { live: ReadonlyMap<string, SosLive>; connected: boolean } {
  const key = useMemo(() => [...new Set(sessionIds)].sort().join(','), [sessionIds])
  const [live, setLive] = useState<ReadonlyMap<string, SosLive>>(() => new Map())
  const [connected, setConnected] = useState(false)
  const mounted = useRef(true)
  const pending = useRef(new Set<string>())
  const timer = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const load = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    const { data, error } = await supabase.from('sos_sessions_view').select(COLS).in('id', ids)
    if (!mounted.current || error) return
    const rows = (data ?? []) as unknown as Row[]
    setLive((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const r of rows) {
        const old = next.get(r.id)
        const m = merge(old, r)
        if (m !== old) { next.set(r.id, m); changed = true }
      }
      return changed ? next : prev
    })
  }, [])

  const schedule = useCallback((id: string) => {
    pending.current.add(id)
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      const ids = [...pending.current]
      pending.current.clear()
      void load(ids)
    }, DEBOUNCE_MS)
  }, [load])

  // initial load + drop sessions that are no longer followed
  useEffect(() => {
    const ids = key ? key.split(',') : []
    setLive((prev) => {
      if ([...prev.keys()].every((id) => ids.includes(id))) return prev
      const next = new Map<string, SosLive>()
      for (const id of ids) { const v = prev.get(id); if (v) next.set(id, v) }
      return next
    })
    void load(ids)
  }, [key, load])

  // Realtime (RLS decides what reaches this subscriber; the filter keeps the traffic to these sessions)
  useEffect(() => {
    if (!key) { setConnected(false); return }
    const channel = supabase
      .channel(`dash-sos-${Math.random().toString(36).slice(2, 10)}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sos_sessions', filter: `id=in.(${key})` },
        (payload) => {
          const id = (payload.new as { id?: string } | null)?.id
          if (id) schedule(id)
        },
      )
      .subscribe((status) => {
        if (!mounted.current) return
        if (status === 'SUBSCRIBED') {
          setConnected(true)
          void load(key.split(',')) // catch up on anything missed while connecting
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnected(false)
        }
      })
    return () => { void supabase.removeChannel(channel) }
  }, [key, load, schedule])

  // polling fallback while Realtime is down; catch up when the tab becomes visible again
  useEffect(() => {
    if (!key) return
    const ids = key.split(',')
    const onVisible = () => { if (document.visibilityState === 'visible') void load(ids) }
    document.addEventListener('visibilitychange', onVisible)
    const poll = connected ? null : window.setInterval(() => { void load(ids) }, POLL_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (poll !== null) window.clearInterval(poll)
    }
  }, [key, connected, load])

  return { live, connected }
}
