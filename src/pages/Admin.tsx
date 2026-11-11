// /admin — operations console (role admin). Sections live in ?s=<section>; each panel is lazy-loaded.
// Realtime (clusters, assignments, reports, sos_sessions) bumps a shared `version` so every panel refreshes silently.
import clsx from 'clsx'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import '../components/admin/admin.css'
import { AdminContext, SECTIONS, type AdminCtx, type LiveState, type Section } from '../components/admin/context'
import { Skeleton } from '../components/admin/parts'
import { AdminShell } from '../components/admin/Shell'
import { adminApi, type AdminOverview } from '../lib/adminApi'
import { useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'

const PANELS: Record<Section, ComponentType> = {
  overview: lazy(() => import('../components/admin/OverviewPanel')),
  map: lazy(() => import('../components/admin/LiveMapPanel')),
  reports: lazy(() => import('../components/admin/ReportsPanel')),
  users: lazy(() => import('../components/admin/UsersPanel')),
  orgs: lazy(() => import('../components/admin/OrgsPanel')),
  assignments: lazy(() => import('../components/admin/AssignmentsPanel')),
  sos: lazy(() => import('../components/admin/SosPanel')),
  notifications: lazy(() => import('../components/admin/NotificationsPanel')),
}

function PanelFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-10 w-64" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
      </div>
      <Skeleton className="h-80 rounded-2xl" />
    </div>
  )
}

const REALTIME_TABLES = ['clusters', 'assignments', 'reports', 'sos_sessions'] as const

export default function Admin() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const raw = params.get('s') as Section | null
  const section: Section = raw && SECTIONS.includes(raw) ? raw : 'overview'
  const [search, setSearch] = useState(() => params.get('q') ?? '')
  const [version, setVersion] = useState(0)
  const [live, setLive] = useState<LiveState>('connecting')
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [overviewError, setOverviewError] = useState<unknown>(null)
  const [toastMsg, setToastMsg] = useState<{ id: number; msg: string; tone: 'ok' | 'error' } | null>(null)

  const go = useCallback((s: Section, opts?: { search?: string }) => {
    if (opts?.search !== undefined) setSearch(opts.search)
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (s === 'overview') next.delete('s')
      else next.set('s', s)
      return next
    }, { replace: false })
    document.querySelector('main')?.scrollTo({ top: 0 })
  }, [setParams])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  // overview powers the KPI tiles + sidebar badges
  useEffect(() => {
    let alive = true
    adminApi.overview().then(
      (o) => { if (alive) { setOverview(o); setOverviewError(null) } },
      (e: unknown) => { if (alive) setOverviewError(e) },
    )
    return () => { alive = false }
  }, [version])

  // realtime: one channel, debounced refresh, remember which ids changed (rows flash)
  const pending = useRef<Set<string>>(new Set())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let ch = supabase.channel(`admin-live-${Math.random().toString(36).slice(2, 8)}`)
    for (const table of REALTIME_TABLES) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        const row = (payload.new && Object.keys(payload.new).length ? payload.new : payload.old) as { id?: string; cluster_id?: string } | null
        if (row?.id) pending.current.add(row.id)
        if (row?.cluster_id) pending.current.add(row.cluster_id)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          setChanged(new Set(pending.current))
          pending.current.clear()
          setVersion((v) => v + 1)
        }, 900)
      })
    }
    ch.subscribe((status) => {
      setLive(status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'offline' : 'connecting')
    })
    // organisations / notifications are not in the realtime publication: poll gently
    const poll = setInterval(() => { if (document.visibilityState === 'visible') setVersion((v) => v + 1) }, 60_000)
    const onVis = () => { if (document.visibilityState === 'visible') setVersion((v) => v + 1) }
    document.addEventListener('visibilitychange', onVis)
    const onOnline = () => setLive('connecting')
    const onOffline = () => setLive('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      void supabase.removeChannel(ch)
    }
  }, [])

  // flashed rows calm down after a moment
  useEffect(() => {
    if (!changed.size) return
    const h = setTimeout(() => setChanged(new Set()), 2200)
    return () => clearTimeout(h)
  }, [changed])

  const toast = useCallback((msg: string, tone: 'ok' | 'error' = 'ok') => setToastMsg({ id: Date.now(), msg, tone }), [])
  useEffect(() => {
    if (!toastMsg) return
    const h = setTimeout(() => setToastMsg(null), 3200)
    return () => clearTimeout(h)
  }, [toastMsg])

  useEffect(() => {
    document.title = `${t(`admin.nav_${section}`)} · ${t('common.appName')} ${t('admin.consoleShort')}`
  }, [section, t])

  const ctx = useMemo<AdminCtx>(() => ({
    section, go, live, version, refresh, search, setSearch, overview, overviewError, toast, changed,
  }), [section, go, live, version, refresh, search, overview, overviewError, toast, changed])

  const Panel = PANELS[section]

  return (
    <AdminContext.Provider value={ctx}>
      <AdminShell>
        <Suspense fallback={<PanelFallback />}>
          <Panel key={section} />
        </Suspense>
      </AdminShell>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4" aria-live="polite">
        <AnimatePresence>
          {toastMsg && (
            <motion.div key={toastMsg.id}
              initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2 }}
              className={clsx('pointer-events-auto flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-xl',
                toastMsg.tone === 'ok' ? 'bg-slate-900' : 'bg-red-600')}>
              {toastMsg.tone === 'ok' ? <CircleCheck className="size-5 text-emerald-400" /> : <CircleAlert className="size-5" />}
              {toastMsg.msg}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </AdminContext.Provider>
  )
}
