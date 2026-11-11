import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Category, MapPin } from '../lib/types'

/** How long a freshly changed pin stays highlighted (ms). */
const HIGHLIGHT_MS = 4500
/** Realtime bursts (recompute + verify + route touch the same cluster several times) are batched into one refetch. */
const BATCH_MS = 400
/** Refetch everything when the tab comes back after being hidden this long (cheap phones drop websockets). */
const STALE_AFTER_HIDDEN_MS = 30_000
const MAX_ROWS = 1000

const EMPTY_SET: ReadonlySet<string> = new Set()

export interface UseClustersResult {
  /** pins after the category filter */
  pins: MapPin[]
  /** every pin from map_pins (unfiltered) */
  allPins: MapPin[]
  byId: ReadonlyMap<string, MapPin>
  loading: boolean
  error: string | null
  /** full reload of map_pins */
  refresh: () => Promise<void>
  /** refetch one cluster now (e.g. right after the user's own report) and highlight it */
  refreshPin: (id: string) => void
  /** id of the most recent pin that arrived / changed via Realtime (null until the first change) */
  lastChangedId: string | null
  /** ids changed in the last few seconds — render a brief highlight animation for these */
  highlighted: ReadonlySet<string>
  /** Realtime channel is subscribed */
  live: boolean
}

/** jsonb columns arrive as fresh objects on every fetch: compare them by value. */
const JSON_KEYS = new Set<keyof MapPin>(['attributes'])

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function shallowEqual(a: MapPin, b: MapPin): boolean {
  const ka = Object.keys(a) as (keyof MapPin)[]
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (a[k] === b[k]) continue
    if (JSON_KEYS.has(k) && jsonEqual(a[k], b[k])) continue
    return false
  }
  return true
}

/** Keep object identity for unchanged rows so memoised markers don't re-render. */
function mergeRows(prev: MapPin[], next: MapPin[]): MapPin[] {
  if (prev.length === 0) return next
  const old = new Map(prev.map((p) => [p.id, p]))
  let same = prev.length === next.length
  const out = next.map((row, i) => {
    const o = old.get(row.id)
    if (o && shallowEqual(o, row)) {
      if (same && prev[i] !== o) same = false
      return o
    }
    same = false
    return row
  })
  return same ? prev : out
}

/**
 * Live list of map pins (the `map_pins` view, one row per cluster).
 * Loads everything once, filters by category client-side, and keeps itself fresh with
 * Realtime postgres_changes on `public.clusters` (refetching only the changed ids from the view).
 */
export function useClusters(categories?: readonly Category[] | null): UseClustersResult {
  const [allPins, setAllPins] = useState<MapPin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastChangedId, setLastChangedId] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(EMPTY_SET)
  const [live, setLive] = useState(false)

  const mounted = useRef(true)
  const pending = useRef(new Set<string>())
  const batchTimer = useRef<number | null>(null)
  const hlTimers = useRef(new Map<string, number>())
  const hiddenAt = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    const timers = hlTimers.current
    return () => {
      mounted.current = false
      if (batchTimer.current !== null) window.clearTimeout(batchTimer.current)
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
    }
  }, [])

  const highlight = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setHighlighted((prev) => {
      const s = new Set(prev)
      for (const id of ids) s.add(id)
      return s
    })
    for (const id of ids) {
      const old = hlTimers.current.get(id)
      if (old !== undefined) window.clearTimeout(old)
      hlTimers.current.set(id, window.setTimeout(() => {
        hlTimers.current.delete(id)
        if (!mounted.current) return
        setHighlighted((prev) => {
          if (!prev.has(id)) return prev
          const s = new Set(prev)
          s.delete(id)
          return s.size ? s : EMPTY_SET
        })
      }, HIGHLIGHT_MS))
    }
  }, [])

  const refresh = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('map_pins')
      .select('*')
      .order('last_report_at', { ascending: false })
      .limit(MAX_ROWS)
    if (!mounted.current) return
    if (err) {
      setError(err.message || 'load_failed')
    } else {
      setError(null)
      setAllPins((prev) => mergeRows(prev, (data ?? []) as MapPin[]))
    }
    setLoading(false)
  }, [])

  /** Refetch the queued ids from map_pins; rows that no longer come back are removed. */
  const flush = useCallback(async () => {
    batchTimer.current = null
    const ids = [...pending.current]
    pending.current.clear()
    if (ids.length === 0) return
    const { data, error: err } = await supabase.from('map_pins').select('*').in('id', ids)
    if (!mounted.current) return
    if (err) {
      // transient: fall back to a full reload so nothing is missed
      void refresh()
      return
    }
    const rows = (data ?? []) as MapPin[]
    const got = new Map(rows.map((r) => [r.id, r]))
    const asked = new Set(ids)
    setAllPins((prev) => {
      const known = new Set(prev.map((p) => p.id))
      const kept = prev
        .filter((p) => !asked.has(p.id) || got.has(p.id))
        .map((p) => {
          const n = got.get(p.id)
          return n && !shallowEqual(p, n) ? n : p
        })
      const added = rows.filter((r) => !known.has(r.id))
      return added.length ? [...added, ...kept] : kept
    })
    if (rows.length) {
      const changed = ids.filter((id) => got.has(id))
      highlight(changed)
      setLastChangedId(changed[changed.length - 1] ?? null)
    }
  }, [highlight, refresh])

  const enqueue = useCallback((id: string, immediate = false) => {
    pending.current.add(id)
    if (immediate) {
      if (batchTimer.current !== null) window.clearTimeout(batchTimer.current)
      void flush()
      return
    }
    if (batchTimer.current === null) batchTimer.current = window.setTimeout(() => { void flush() }, BATCH_MS)
  }, [flush])

  const refreshPin = useCallback((id: string) => enqueue(id, true), [enqueue])

  // initial load
  useEffect(() => { void refresh() }, [refresh])

  // Realtime: any change on public.clusters -> refetch that id from the view
  useEffect(() => {
    let wasDown = false
    // unique topic per mount: StrictMode double-mount must not reuse a channel that is being torn down
    const topic = `map-clusters-${Math.random().toString(36).slice(2, 10)}`
    const channel = supabase
      .channel(topic)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clusters' },
        (payload: RealtimePostgresChangesPayload<{ id?: string }>) => {
          const row = payload.eventType === 'DELETE' ? payload.old : payload.new
          const id = row && typeof row.id === 'string' ? row.id : null
          if (id) enqueue(id)
        },
      )
      .subscribe((status) => {
        if (!mounted.current) return
        if (status === 'SUBSCRIBED') {
          setLive(true)
          // we may have missed events while disconnected
          if (wasDown) void refresh()
          wasDown = false
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setLive(false)
          wasDown = true
        }
      })
    return () => { void supabase.removeChannel(channel) }
  }, [enqueue, refresh])

  // Coming back to the app / network: catch up
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = Date.now(); return }
      if (hiddenAt.current !== null && Date.now() - hiddenAt.current > STALE_AFTER_HIDDEN_MS) void refresh()
      hiddenAt.current = null
    }
    const onOnline = () => { void refresh() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
  }, [refresh])

  const filterKey = categories && categories.length ? [...categories].sort().join(',') : ''
  const pins = useMemo(() => {
    if (!filterKey) return allPins
    const allow = new Set(filterKey.split(','))
    return allPins.filter((p) => allow.has(p.category))
  }, [allPins, filterKey])

  const byId = useMemo(() => new Map(allPins.map((p) => [p.id, p])), [allPins])

  return { pins, allPins, byId, loading, error, refresh, refreshPin, lastChangedId, highlighted, live }
}
