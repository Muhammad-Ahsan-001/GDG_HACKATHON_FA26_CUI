import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import type { AssignmentActionKind, DashAssignment } from './types'

export type LiveState = 'connecting' | 'live' | 'offline'

const MAX_ROWS = 500
const DEBOUNCE_MS = 350
const POLL_WHEN_OFFLINE_MS = 20_000

export type ActionResult = { ok: true } | { ok: false; message: string }

/**
 * Loads `my_assignments` (RLS/view: the caller's orgs, admins: all) and keeps it live:
 * postgres_changes on public.assignments (INSERT/UPDATE) and public.clusters (UPDATE) -> debounced refetch.
 * `onNew` fires with assignments that appeared since the previous load (status 'alerted').
 */
export function useAssignments(orgId: string | null, onNew: (fresh: DashAssignment[]) => void) {
  const [rows, setRows] = useState<DashAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState>('connecting')
  const [version, setVersion] = useState(0)
  /** org filter key ('all' or an org id) the current rows were loaded for */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Partial<DashAssignment>>>({})
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const knownRef = useRef<Set<string> | null>(null)
  const clusterIdsRef = useRef<Set<string>>(new Set())
  const seqRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())
  const onNewRef = useRef(onNew)
  useEffect(() => { onNewRef.current = onNew }, [onNew])

  const fetchRows = useCallback(async () => {
    const seq = ++seqRef.current
    let q = supabase.from('my_assignments').select('*').order('alerted_at', { ascending: false }).limit(MAX_ROWS)
    if (orgId) q = q.eq('org_id', orgId)
    const { data, error: err } = await q
    if (seq !== seqRef.current) return // a newer request superseded this one
    setLoading(false)
    if (err) { setError(err.message); return }
    setError(null)
    const list = (data ?? []) as DashAssignment[]
    const known = knownRef.current
    if (known) {
      const fresh = list.filter((r) => r.status === 'alerted' && !known.has(r.assignment_id))
      if (fresh.length) onNewRef.current(fresh)
    }
    knownRef.current = new Set(list.map((r) => r.assignment_id))
    clusterIdsRef.current = new Set(list.map((r) => r.cluster_id))
    setRows(list)
    setLoadedKey(orgId ?? 'all')
    setVersion((v) => v + 1)
  }, [orgId])

  const fetchRef = useRef(fetchRows)
  useEffect(() => { fetchRef.current = fetchRows }, [fetchRows])

  const scheduleRefetch = useCallback((delay = DEBOUNCE_MS) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void fetchRef.current()
    }, delay)
  }, [])

  // (Re)load when the org filter changes. The first load never counts as "new alerts".
  useEffect(() => {
    knownRef.current = null
    setLoading(true)
    setRows([])
    setOverrides({})
    void fetchRows()
  }, [fetchRows])

  // Realtime. RLS decides which assignment rows reach this subscriber.
  useEffect(() => {
    let wasLive = false
    const channel = supabase
      .channel(`dashboard-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'assignments' }, () => scheduleRefetch())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'assignments' }, () => scheduleRefetch())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'clusters' }, (payload) => {
        const id = (payload.new as { id?: string } | null)?.id
        if (id && clusterIdsRef.current.has(id)) scheduleRefetch()
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setLive('live')
          // after a reconnect, catch up on anything missed while disconnected
          if (wasLive) scheduleRefetch(0)
          wasLive = true
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setLive('offline')
        }
      })
    return () => {
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null }
      void supabase.removeChannel(channel)
    }
  }, [scheduleRefetch])

  // Fallback polling while realtime is down; refetch when the tab/app comes back or the network returns.
  useEffect(() => {
    if (live === 'live') return
    const id = window.setInterval(() => scheduleRefetch(0), POLL_WHEN_OFFLINE_MS)
    return () => window.clearInterval(id)
  }, [live, scheduleRefetch])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefetch(0) }
    const onOnline = () => scheduleRefetch(0)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [scheduleRefetch])

  /** Claim / start / resolve with an optimistic update; rolled back if the server refuses. */
  const act = useCallback(async (row: DashAssignment, action: AssignmentActionKind): Promise<ActionResult> => {
    const id = row.assignment_id
    if (pendingRef.current.has(id)) return { ok: true }
    pendingRef.current.add(id)
    setPending(new Set(pendingRef.current))

    const now = new Date().toISOString()
    const patch: Partial<DashAssignment> =
      action === 'claim'
        ? { status: 'claimed', claimed_at: row.claimed_at ?? now }
        : action === 'start'
          ? {
              status: 'in_progress', in_progress_at: now, claimed_at: row.claimed_at ?? now,
              cluster_status: row.cluster_status === 'resolved' ? 'resolved' : 'in_progress',
            }
          : { status: 'resolved', resolved_at: now, claimed_at: row.claimed_at ?? now, cluster_status: 'resolved' }
    setOverrides((o) => ({ ...o, [id]: patch }))

    let result: ActionResult
    try {
      const res = await api.assignmentAction(id, action)
      setRows((rs) => rs.map((r) => (r.assignment_id === id
        ? { ...r, ...patch, status: res.status ?? patch.status ?? r.status, cluster_status: res.cluster_status ?? patch.cluster_status ?? r.cluster_status }
        : r)))
      result = { ok: true }
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
    // drop the optimistic layer (on error this IS the rollback)
    setOverrides((o) => {
      const next = { ...o }
      delete next[id]
      return next
    })
    pendingRef.current.delete(id)
    setPending(new Set(pendingRef.current))
    scheduleRefetch()
    return result
  }, [scheduleRefetch])

  const items = useMemo(
    () => rows.map((r) => (overrides[r.assignment_id] ? { ...r, ...overrides[r.assignment_id] } : r)),
    [rows, overrides],
  )

  const refresh = useCallback(() => scheduleRefetch(0), [scheduleRefetch])

  return { items, loading, error, live, version, loadedKey, pending, act, refresh }
}
