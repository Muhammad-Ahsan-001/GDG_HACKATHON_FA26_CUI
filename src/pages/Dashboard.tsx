import clsx from 'clsx'
import { Clock, List, Map as MapIcon, RefreshCw, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import '../components/dashboard/dashboard.css'
import { AlertToasts, type ToastItem } from '../components/dashboard/AlertToast'
import { AssignmentCard } from '../components/dashboard/AssignmentCard'
import { DashboardMap, type ServiceArea } from '../components/dashboard/DashboardMap'
import { EnableAlertsButton } from '../components/dashboard/EnableAlertsButton'
import { ListPanel } from '../components/dashboard/ListPanel'
import { NoOrgCta, PendingApproval } from '../components/dashboard/OrgGate'
import { OrgTypeIcon, useOrgTypeLabel } from '../components/dashboard/orgTypes'
import { StatsRow } from '../components/dashboard/StatsRow'
import { tabOf, type AssignmentActionKind, type CategoryFilter, type DashAssignment, type DashOrg, type DashTab, type MapFocus } from '../components/dashboard/types'
import { useAssignments, type LiveState } from '../components/dashboard/useAssignments'
import { beep, unlockAudio, vibrate } from '../components/dashboard/alerts'
import { formatKm, readLocal, sortForTab, useMediaQuery, writeLocal } from '../components/dashboard/utils'
import { AppHeader } from '../components/layout/AppHeader'
import { Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import type { Category } from '../lib/types'

const SOUND_KEY = 'awaaz.dashboard.sound'
const HIGHLIGHT_MS = 45_000

let toastSeq = 0
const toastId = () => `t${Date.now().toString(36)}${(toastSeq++).toString(36)}`

/** Responder / NGO dashboard: live alert list + map for the signed-in organisation (admins: all orgs). */
export default function Dashboard() {
  const { user, profile, role, orgs: authOrgs, refreshProfile } = useAuth()
  const isAdmin = role === 'admin'
  const uid = user?.id
  const profileReady = Boolean(profile)
  const [orgList, setOrgList] = useState<DashOrg[] | null>(null)
  const [checking, setChecking] = useState(false)

  // useAuth().orgs is the primary source; this own read of org_directory confirms it (avoids a
  // "register" flash while the auth context is still loading) and gives admins every organisation.
  const loadOrgs = useCallback(async () => {
    if (!uid || !profileReady) return
    let q = supabase.from('org_directory').select('*').order('name')
    if (!isAdmin) q = q.eq('owner_id', uid)
    const { data, error } = await q
    setOrgList(error ? (authOrgs as DashOrg[]) : ((data ?? []) as DashOrg[]))
  }, [uid, profileReady, isAdmin, authOrgs])

  useEffect(() => { void loadOrgs() }, [loadOrgs])

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      await refreshProfile()
      await loadOrgs()
    } finally {
      setChecking(false)
    }
  }, [refreshProfile, loadOrgs])

  const orgs = orgList ?? (!isAdmin && authOrgs.length ? (authOrgs as DashOrg[]) : null)

  if (!profileReady || orgs === null) {
    return <Shell><div className="flex justify-center p-12 text-brand-700"><Spinner className="size-10" /></div></Shell>
  }
  if (!isAdmin) {
    if (orgs.length === 0) return <Shell><NoOrgCta /></Shell>
    const approved = orgs.filter((o) => o.approved !== false)
    if (approved.length === 0) {
      return <Shell><PendingApproval orgs={orgs} onRecheck={() => { void recheck() }} checking={checking} /></Shell>
    }
    return <DashboardBody orgs={approved} pendingOrgs={orgs.filter((o) => o.approved === false)} isAdmin={false} />
  }
  return <DashboardBody orgs={orgs} pendingOrgs={[]} isAdmin />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-slate-50">
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  )
}

// DAILY_DIGEST_HOOK (Phase 2 daily AI summary): render the org's daily AI digest card here
// (api.digestDaily(orgId) -> { en, ur }, shown with <AiLabel/>). Intentionally renders nothing for now.
function DailyDigestSlot() {
  return null
}

function DashboardBody({ orgs, pendingOrgs, isAdmin }: { orgs: DashOrg[]; pendingOrgs: DashOrg[]; isAdmin: boolean }) {
  const { t } = useI18n()
  const isDesktop = useMediaQuery('(min-width: 1024px)')

  // ---- filters / view state ----
  const [orgFilter, setOrgFilter] = useState<string>(() => (!isAdmin && orgs.length === 1 ? orgs[0].id : 'all'))
  const filterOrg = orgs.find((o) => o.id === orgFilter) ?? (!isAdmin && orgs.length === 1 ? orgs[0] : null)
  const orgId = filterOrg?.id ?? null
  const [tab, setTab] = useState<DashTab>('new')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [view, setView] = useState<'list' | 'map'>('list')
  const [mapWanted, setMapWanted] = useState(false)
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set())
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [sound, setSound] = useState(() => readLocal(SOUND_KEY, '1') !== '0')
  const soundRef = useRef(sound)
  useEffect(() => { soundRef.current = sound }, [sound])

  // browsers only allow audio after a user gesture: unlock the AudioContext on the first tap
  useEffect(() => {
    const onDown = () => unlockAudio()
    window.addEventListener('pointerdown', onDown, { once: true })
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])

  // ---- toasts ----
  const pushToast = useCallback((toast: ToastItem) => setToasts((ts) => [...ts.slice(-4), toast]), [])
  const dismissToast = useCallback((id: string) => setToasts((ts) => ts.filter((x) => x.id !== id)), [])

  const unhighlight = useCallback((id: string) => {
    setHighlight((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // ---- new alert: highlight + beep + vibrate + toast ----
  const onNew = useCallback((fresh: DashAssignment[]) => {
    const ids = fresh.map((f) => f.assignment_id)
    setHighlight((prev) => new Set([...prev, ...ids]))
    window.setTimeout(() => {
      setHighlight((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    }, HIGHLIGHT_MS)
    if (soundRef.current) beep()
    vibrate()
    const top = sortForTab(fresh, 'new')[0]
    pushToast({
      id: toastId(), kind: 'new', assignmentId: top.assignment_id, category: top.category,
      title_en: top.title_en, title_ur: top.title_ur, more: fresh.length - 1,
    })
  }, [pushToast])

  const { items, loading, error, live, version, loadedKey, pending, act, refresh } = useAssignments(orgId, onNew)

  // reset the selection when switching organisation
  useEffect(() => { setSelectedId(null); setCategory('all') }, [orgId])

  // ---- derived lists ----
  const byTab = useMemo(() => {
    const g: Record<DashTab, DashAssignment[]> = { new: [], active: [], done: [] }
    for (const a of items) g[tabOf(a)].push(a)
    return g
  }, [items])

  const matchesCat = useCallback((a: DashAssignment) => category === 'all' || a.category === category, [category])

  const counts = useMemo<Record<DashTab, number>>(() => ({
    new: byTab.new.filter(matchesCat).length,
    active: byTab.active.filter(matchesCat).length,
    done: byTab.done.filter(matchesCat).length,
  }), [byTab, matchesCat])

  const categoryCounts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {}
    for (const a of items) c[a.category] = c[a.category] ?? 0
    for (const a of byTab[tab]) c[a.category] = (c[a.category] ?? 0) + 1
    if (category !== 'all') c[category] = c[category] ?? 0
    return c
  }, [items, byTab, tab, category])

  const visible = useMemo(() => sortForTab(byTab[tab].filter(matchesCat), tab), [byTab, tab, matchesCat])

  const attention = useMemo(() => {
    const s = new Set<DashTab>()
    for (const a of items) if (highlight.has(a.assignment_id)) s.add(tabOf(a))
    return s
  }, [items, highlight])

  const selected = useMemo(() => items.find((a) => a.assignment_id === selectedId) ?? null, [items, selectedId])

  const areas = useMemo<ServiceArea[]>(
    () => (filterOrg ? [filterOrg] : isAdmin ? [] : orgs)
      .map((o) => ({ id: o.id, name: o.name, lat: o.lat, lng: o.lng, radius_m: o.radius_m })),
    [filterOrg, isAdmin, orgs],
  )

  // ---- interactions ----
  const scrollToCard = (id: string) => {
    requestAnimationFrame(() => {
      document.getElementById(`dash-card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  const selectCard = useCallback((a: DashAssignment) => {
    setSelectedId((cur) => (cur === a.assignment_id ? null : a.assignment_id))
    setFocus({ lat: a.lat, lng: a.lng })
    unhighlight(a.assignment_id)
  }, [unhighlight])

  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id)
    unhighlight(id)
    scrollToCard(id)
  }, [unhighlight])

  const openFromToast = useCallback((id: string) => {
    const a = items.find((x) => x.assignment_id === id)
    setCategory('all')
    setTab(a ? tabOf(a) : 'new')
    setSelectedId(id)
    unhighlight(id)
    if (a) setFocus({ lat: a.lat, lng: a.lng })
    scrollToCard(id)
  }, [items, unhighlight])

  const onAction = useCallback(async (a: DashAssignment, action: AssignmentActionKind) => {
    const prevTab = tab
    const nextTab: DashTab = action === 'resolve' ? 'done' : 'active'
    // follow the card to its new tab so Claim -> Start work -> Mark resolved is one continuous flow
    setSelectedId(a.assignment_id)
    setTab(nextTab)
    unhighlight(a.assignment_id)
    scrollToCard(a.assignment_id)
    const res = await act(a, action)
    if (res.ok) {
      pushToast({ id: toastId(), kind: 'ok', message: t(`dashboard.done_${action}`) })
    } else {
      setTab(prevTab)
      pushToast({ id: toastId(), kind: 'error', message: t('dashboard.actionFailed') })
    }
  }, [act, pushToast, t, tab, unhighlight])

  const onActionVoid = useCallback((a: DashAssignment, action: AssignmentActionKind) => { void onAction(a, action) }, [onAction])

  const toggleSound = () => {
    const next = !sound
    setSound(next)
    writeLocal(SOUND_KEY, next ? '1' : '0')
    if (next) { unlockAudio(); beep() }
  }

  const showView = (v: 'list' | 'map') => {
    setView(v)
    if (v === 'map') setMapWanted(true)
  }

  const showOrgOnCards = isAdmin ? !filterOrg : orgs.length > 1 && !filterOrg
  const mapMounted = isDesktop || mapWanted

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-slate-50">
      <AppHeader />

      {/* Org context + device controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <OrgHeading org={filterOrg} isAdmin={isAdmin} />
        {(isAdmin || orgs.length > 1) && (
          <label className="flex min-w-0 items-center">
            <span className="sr-only">{t('dashboard.orgFilter')}</span>
            <select
              value={filterOrg ? filterOrg.id : 'all'}
              onChange={(e) => setOrgFilter(e.target.value)}
              className="min-h-12 max-w-[16rem] rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold"
            >
              <option value="all">{isAdmin ? t('dashboard.allOrgs') : t('dashboard.allMyOrgs')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}{o.approved === false ? ` (${t('dashboard.pendingShort')})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex-1" />
        <LiveIndicator live={live} onRefresh={refresh} />
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={sound}
          aria-label={sound ? t('dashboard.soundOn') : t('dashboard.soundOff')}
          title={sound ? t('dashboard.soundOn') : t('dashboard.soundOff')}
          className={clsx(
            'inline-flex size-12 items-center justify-center rounded-full border',
            sound ? 'border-brand-700 bg-brand-50 text-brand-700' : 'border-slate-300 bg-white text-slate-500',
          )}
        >
          {sound ? <Volume2 className="size-6" /> : <VolumeX className="size-6" />}
        </button>
        <EnableAlertsButton />
      </div>

      {pendingOrgs.length > 0 && (
        <div role="status" className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
          <Clock className="size-5 shrink-0" />
          <span className="min-w-0 truncate">{t('dashboard.pendingSome', { names: pendingOrgs.map((o) => o.name).join(', ') })}</span>
        </div>
      )}

      <div className={clsx('border-b border-slate-200 bg-slate-50', view === 'map' && 'hidden lg:block')}>
        <StatsRow orgId={orgId} refreshKey={version} onPickTab={(tb) => { setTab(tb); showView('list') }} />
      </div>

      {/* Mobile: List | Map */}
      <div className="grid grid-cols-2 gap-1.5 border-b border-slate-200 bg-white px-3 py-2 lg:hidden" role="tablist">
        {([['list', List, 'dashboard.viewList'], ['map', MapIcon, 'dashboard.viewMap']] as const).map(([v, Icon, key]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => showView(v)}
            className={clsx(
              'inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl font-bold',
              view === v ? 'bg-ink text-white' : 'bg-slate-100 text-slate-700',
            )}
          >
            <Icon className="size-5" /> {t(key)}
            {v === 'list' && attention.size > 0 && view !== 'list' && (
              <span aria-hidden className="awaaz-dash-blink size-3 rounded-full bg-red-600" />
            )}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* List column (desktop: ~440 px) */}
        <section
          className={clsx(
            'min-h-0 w-full flex-col border-slate-200 bg-white lg:flex lg:w-[440px] lg:shrink-0 lg:border-e',
            view === 'list' ? 'flex' : 'hidden',
          )}
        >
          <DailyDigestSlot />
          <ListPanel
            tab={tab}
            onTab={setTab}
            counts={counts}
            attention={attention}
            category={category}
            onCategory={setCategory}
            categoryCounts={categoryCounts}
            items={visible}
            loading={loading}
            error={error}
            onRetry={refresh}
            selectedId={selectedId}
            highlightIds={highlight}
            pending={pending}
            showOrg={showOrgOnCards}
            onSelect={selectCard}
            onAction={onActionVoid}
          />
        </section>

        {/* Map (fills the rest) */}
        <section className={clsx('relative min-h-0 flex-1 lg:block', view === 'map' ? 'block' : 'hidden')}>
          {mapMounted && (
            <DashboardMap
              items={visible}
              selectedId={selectedId}
              highlightIds={highlight}
              areas={areas}
              focus={focus}
              fitKey={orgId ?? 'all'}
              ready={!loading && loadedKey === (orgId ?? 'all')}
              onSelect={selectFromMap}
              onBackgroundClick={() => setSelectedId(null)}
            />
          )}
          {!isDesktop && view === 'map' && selected && (
            <div className="absolute inset-x-2 bottom-2 z-10 max-h-[62%] overflow-y-auto rounded-2xl pb-[env(safe-area-inset-bottom)]">
              <div className="relative">
                <button
                  type="button"
                  aria-label={t('common.close')}
                  onClick={() => setSelectedId(null)}
                  className="absolute -top-1 end-1 z-10 inline-flex size-11 items-center justify-center rounded-full bg-white shadow"
                >
                  <X className="size-5" />
                </button>
                <AssignmentCard
                  a={selected}
                  pending={pending.has(selected.assignment_id)}
                  highlighted={highlight.has(selected.assignment_id)}
                  showOrg={showOrgOnCards}
                  onSelect={(a) => setFocus({ lat: a.lat, lng: a.lng })}
                  onAction={onActionVoid}
                />
              </div>
            </div>
          )}
        </section>
      </div>

      <AlertToasts toasts={toasts} onOpen={openFromToast} onDismiss={dismissToast} />
    </div>
  )
}

function OrgHeading({ org, isAdmin }: { org: DashOrg | null; isAdmin: boolean }) {
  const { t } = useI18n()
  const typeLabel = useOrgTypeLabel()
  if (!org) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-white">
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate font-extrabold">{isAdmin ? t('dashboard.adminTitle') : t('dashboard.title')}</div>
          <div className="truncate text-xs text-slate-500">{isAdmin ? t('dashboard.adminSubtitle') : t('dashboard.allMyOrgs')}</div>
        </div>
      </div>
    )
  }
  const radius = org.radius_m ? formatKm(org.radius_m, t) : null
  return (
    <div className="flex min-w-0 items-center gap-2">
      <OrgTypeIcon type={org.org_type} size={44} />
      <div className="min-w-0">
        <div className="truncate font-extrabold">{org.name}</div>
        <div className="truncate text-xs text-slate-500">
          {typeLabel(org.org_type)}
          {radius ? <> · {t('dashboard.serviceRadius', { km: radius })}</> : null}
        </div>
      </div>
    </div>
  )
}

function LiveIndicator({ live, onRefresh }: { live: LiveState; onRefresh: () => void }) {
  const { t } = useI18n()
  const color = live === 'live' ? '#16A34A' : live === 'connecting' ? '#CA8A04' : '#DC2626'
  const label = live === 'live' ? t('dashboard.live') : live === 'connecting' ? t('dashboard.connecting') : t('dashboard.offlineRetry')
  return (
    <button
      type="button"
      onClick={onRefresh}
      title={`${label} · ${t('dashboard.refresh')}`}
      aria-label={`${label} · ${t('dashboard.refresh')}`}
      className="inline-flex min-h-12 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-bold hover:bg-slate-50"
      style={{ color }}
    >
      <span className="relative inline-flex size-3">
        {live === 'live' && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
        <span className="relative inline-flex size-3 rounded-full" style={{ background: color }} />
      </span>
      <span className="hidden sm:inline">{label}</span>
      <RefreshCw className="size-4 text-slate-400" />
    </button>
  )
}
