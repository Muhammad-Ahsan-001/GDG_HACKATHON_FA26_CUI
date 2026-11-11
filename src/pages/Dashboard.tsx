import clsx from 'clsx'
import { Clock, List, Map as MapIcon, RefreshCw, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import '../components/dashboard/dashboard.css'
import { AlertToasts, type ToastItem } from '../components/dashboard/AlertToast'
import { AssignmentCard } from '../components/dashboard/AssignmentCard'
import { DailyDigest } from '../components/dashboard/DailyDigest'
import { DashboardMap, type ServiceArea } from '../components/dashboard/DashboardMap'
import { EnableAlertsButton } from '../components/dashboard/EnableAlertsButton'
import { ListPanel, type SosListContext } from '../components/dashboard/ListPanel'
import { NoOrgCta, PendingApproval } from '../components/dashboard/OrgGate'
import { OrgTypeIcon, useOrgTypeLabel } from '../components/dashboard/orgTypes'
import { SosCard } from '../components/dashboard/SosCard'
import { StatsRow } from '../components/dashboard/StatsRow'
import { tabOf, type AssignmentActionKind, type CategoryFilter, type DashAssignment, type DashOrg, type DashTab, type MapFocus } from '../components/dashboard/types'
import { useAssignments, type LiveState } from '../components/dashboard/useAssignments'
import { isSos, useSosLive } from '../components/dashboard/useSosLive'
import { beep, siren, unlockAudio, vibrate, vibrateSos } from '../components/dashboard/alerts'
import { formatKm, readLocal, sortForTab, useMediaQuery, writeLocal } from '../components/dashboard/utils'
import { AppHeader } from '../components/layout/AppHeader'
import { Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import type { Category } from '../lib/types'

const SOUND_KEY = 'awaaz.dashboard.sound'
const HIGHLIGHT_MS = 45_000
/** An unclaimed SOS keeps sounding until someone touches it / claims it (max SOS_ALARM_MAX repeats). */
const SOS_ALARM_EVERY_MS = 12_000
const SOS_ALARM_MAX = 5
/** On opening the dashboard, unclaimed SOS alerts younger than this start the alarm too. */
const SOS_ALARM_ON_LOAD_MS = 30 * 60_000

const ts = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0)

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

// DAILY_DIGEST_HOOK (Phase 2 daily AI summary): collapsible AI digest card at the top of the list column.
// One organisation selected -> that org's last 24 h; admin / "all" filter -> city-wide.
function DailyDigestSlot({ orgId, orgName }: { orgId: string | null; orgName?: string | null }) {
  return <DailyDigest orgId={orgId} orgName={orgName} />
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
  /** SOS alert whose live location the map follows */
  const [followId, setFollowId] = useState<string | null>(null)
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

  // ---- SOS alarm (repeats while an SOS is unclaimed and untouched) ----
  const [alarmIds, setAlarmIds] = useState<ReadonlySet<string>>(() => new Set())
  const alarmCount = useRef(0)
  const ackSos = useCallback((a: DashAssignment) => {
    setAlarmIds((prev) => {
      if (!prev.has(a.assignment_id)) return prev
      const next = new Set(prev)
      next.delete(a.assignment_id)
      return next
    })
  }, [])

  // ---- new alert: highlight + beep / SOS siren + vibrate + toast ----
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
    const sosFresh = fresh.filter(isSos)
    const regular = fresh.filter((a) => !isSos(a))
    if (sosFresh.length) {
      // loud, distinct, insistent: a person may be in danger right now
      if (soundRef.current) siren()
      vibrateSos()
      alarmCount.current = 0
      setAlarmIds((prev) => new Set([...prev, ...sosFresh.map((a) => a.assignment_id)]))
      const top = sosFresh[0]
      pushToast({
        id: toastId(), kind: 'new', sos: true, assignmentId: top.assignment_id, category: top.category,
        title_en: top.title_en, title_ur: top.title_ur, more: sosFresh.length - 1,
      })
    }
    if (regular.length) {
      if (!sosFresh.length) {
        if (soundRef.current) beep()
        vibrate()
      }
      const top = sortForTab(regular, 'new')[0]
      pushToast({
        id: toastId(), kind: 'new', assignmentId: top.assignment_id, category: top.category,
        title_en: top.title_en, title_ur: top.title_ur, more: regular.length - 1,
      })
    }
  }, [pushToast])

  const { items, loading, error, live, version, loadedKey, pending, act, refresh } = useAssignments(orgId, onNew)

  // reset the selection when switching organisation
  useEffect(() => { setSelectedId(null); setCategory('all'); setFollowId(null) }, [orgId])

  // ---- SOS: active alerts are pinned above every tab, with live location from their sessions ----
  const pinned = useMemo(() => items
    .filter((a) => isSos(a) && a.status !== 'resolved')
    .sort((x, y) => (x.status === 'alerted' ? 0 : 1) - (y.status === 'alerted' ? 0 : 1) || ts(y.alerted_at) - ts(x.alerted_at)),
  [items])
  const regularItems = useMemo(() => items.filter((a) => !(isSos(a) && a.status !== 'resolved')), [items])
  const sosSessionIds = useMemo(
    () => pinned.map((a) => a.sos_session_id).filter((x): x is string => Boolean(x)),
    [pinned],
  )
  const { live: sosLive } = useSosLive(sosSessionIds)

  // unclaimed recent SOS alerts already waiting when the dashboard opens also start the alarm
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (loading || loadedKey === null || seededFor.current === loadedKey) return
    seededFor.current = loadedKey
    const now = Date.now()
    const waiting = items.filter((a) => isSos(a) && a.status === 'alerted' && now - ts(a.alerted_at) < SOS_ALARM_ON_LOAD_MS)
    if (waiting.length) setAlarmIds((prev) => new Set([...prev, ...waiting.map((a) => a.assignment_id)]))
  }, [loading, loadedKey, items])

  const alarmActive = useMemo(
    () => pinned.some((a) => a.status === 'alerted' && alarmIds.has(a.assignment_id)),
    [pinned, alarmIds],
  )
  useEffect(() => {
    if (!alarmActive || !sound) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || alarmCount.current >= SOS_ALARM_MAX) return
      alarmCount.current++
      siren()
      vibrateSos()
    }, SOS_ALARM_EVERY_MS)
    return () => window.clearInterval(id)
  }, [alarmActive, sound])

  // ---- derived lists ----
  const byTab = useMemo(() => {
    const g: Record<DashTab, DashAssignment[]> = { new: [], active: [], done: [] }
    for (const a of regularItems) g[tabOf(a)].push(a)
    return g
  }, [regularItems])

  const matchesCat = useCallback((a: DashAssignment) => category === 'all' || a.category === category, [category])

  const counts = useMemo<Record<DashTab, number>>(() => ({
    new: byTab.new.filter(matchesCat).length,
    active: byTab.active.filter(matchesCat).length,
    done: byTab.done.filter(matchesCat).length,
  }), [byTab, matchesCat])

  const categoryCounts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {}
    for (const a of regularItems) c[a.category] = c[a.category] ?? 0
    for (const a of byTab[tab]) c[a.category] = (c[a.category] ?? 0) + 1
    if (category !== 'all') c[category] = c[category] ?? 0
    return c
  }, [regularItems, byTab, tab, category])

  const visible = useMemo(() => sortForTab(byTab[tab].filter(matchesCat), tab), [byTab, tab, matchesCat])

  const attention = useMemo(() => {
    const s = new Set<DashTab>()
    for (const a of regularItems) if (highlight.has(a.assignment_id)) s.add(tabOf(a))
    return s
  }, [regularItems, highlight])

  // the map always shows the active SOS alerts, whatever tab is open
  const mapItems = useMemo(() => {
    if (!pinned.length) return visible
    const shown = new Set(visible.map((a) => a.assignment_id))
    return [...pinned.filter((a) => !shown.has(a.assignment_id)), ...visible]
  }, [pinned, visible])

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

  /** where an alert is right now (SOS: the live location of the person) */
  const pointOf = useCallback((a: DashAssignment): MapFocus => {
    const live = a.sos_session_id ? sosLive.get(a.sos_session_id) : undefined
    return live && live.lat != null && live.lng != null ? { lat: live.lat, lng: live.lng } : { lat: a.lat, lng: a.lng }
  }, [sosLive])

  const selectCard = useCallback((a: DashAssignment) => {
    setSelectedId((cur) => (cur === a.assignment_id ? null : a.assignment_id))
    setFocus(pointOf(a))
    unhighlight(a.assignment_id)
    ackSos(a)
  }, [unhighlight, ackSos, pointOf])

  const selectFromMap = useCallback((id: string) => {
    setSelectedId(id)
    unhighlight(id)
    const a = items.find((x) => x.assignment_id === id)
    if (a) ackSos(a)
    scrollToCard(id)
  }, [unhighlight, items, ackSos])

  // ---- SOS follow-on-map ----
  const followIdRef = useRef(followId)
  useEffect(() => { followIdRef.current = followId }, [followId])
  const onFollow = useCallback((a: DashAssignment) => {
    ackSos(a)
    if (followIdRef.current === a.assignment_id) { setFollowId(null); return }
    setFollowId(a.assignment_id)
    setSelectedId(a.assignment_id)
    if (!isDesktop) { setView('map'); setMapWanted(true) }
  }, [ackSos, isDesktop])
  const cancelFollow = useCallback(() => setFollowId(null), [])
  const followItem = followId ? items.find((a) => a.assignment_id === followId) ?? null : null
  const follow = followItem ? pointOf(followItem) : null

  const sosCtx = useMemo<SosListContext>(
    () => ({ live: sosLive, followId, onFollow, onAck: ackSos }),
    [sosLive, followId, onFollow, ackSos],
  )

  const openFromToast = useCallback((id: string) => {
    const a = items.find((x) => x.assignment_id === id)
    setCategory('all')
    // pinned SOS cards are visible on every tab
    if (!a || !isSos(a) || a.status === 'resolved') setTab(a ? tabOf(a) : 'new')
    setSelectedId(id)
    unhighlight(id)
    if (a) { setFocus(pointOf(a)); ackSos(a) }
    scrollToCard(id)
  }, [items, unhighlight, pointOf, ackSos])

  const onAction = useCallback(async (a: DashAssignment, action: AssignmentActionKind) => {
    const prevTab = tab
    const nextTab: DashTab = action === 'resolve' ? 'done' : 'active'
    // pinned (active SOS) cards stay where they are until resolved
    const staysPinned = isSos(a) && action !== 'resolve'
    // follow the card to its new tab so Claim -> Start work -> Mark resolved is one continuous flow
    setSelectedId(a.assignment_id)
    if (!staysPinned) setTab(nextTab)
    unhighlight(a.assignment_id)
    ackSos(a)
    scrollToCard(a.assignment_id)
    const res = await act(a, action)
    if (res.ok) {
      pushToast({ id: toastId(), kind: 'ok', message: t(isSos(a) ? `dashboard.sosDone_${action}` : `dashboard.done_${action}`) })
    } else {
      if (!staysPinned) setTab(prevTab)
      pushToast({ id: toastId(), kind: 'error', message: t('dashboard.actionFailed') })
    }
  }, [act, pushToast, t, tab, unhighlight, ackSos])

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
              view === v ? 'bg-brand-700 text-white shadow-sm shadow-brand-700/25' : 'bg-slate-100 text-slate-700',
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
          <DailyDigestSlot orgId={orgId} orgName={filterOrg?.name} />
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
            pinned={pinned}
            sos={sosCtx}
          />
        </section>

        {/* Map (fills the rest) */}
        <section className={clsx('relative min-h-0 flex-1 lg:block', view === 'map' ? 'block' : 'hidden')}>
          {mapMounted && (
            <DashboardMap
              items={mapItems}
              selectedId={selectedId}
              highlightIds={highlight}
              areas={areas}
              focus={focus}
              fitKey={orgId ?? 'all'}
              ready={!loading && loadedKey === (orgId ?? 'all')}
              onSelect={selectFromMap}
              onBackgroundClick={() => setSelectedId(null)}
              sosLive={sosLive}
              follow={follow}
              onFollowCancel={cancelFollow}
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
                {isSos(selected) ? (
                  <SosCard
                    a={selected}
                    live={selected.sos_session_id ? sosLive.get(selected.sos_session_id) : undefined}
                    pending={pending.has(selected.assignment_id)}
                    highlighted={highlight.has(selected.assignment_id)}
                    following={followId === selected.assignment_id}
                    showOrg={showOrgOnCards}
                    onSelect={(a) => setFocus(pointOf(a))}
                    onAction={onActionVoid}
                    onFollow={onFollow}
                    onAck={ackSos}
                  />
                ) : (
                  <AssignmentCard
                    a={selected}
                    pending={pending.has(selected.assignment_id)}
                    highlighted={highlight.has(selected.assignment_id)}
                    showOrg={showOrgOnCards}
                    onSelect={(a) => setFocus({ lat: a.lat, lng: a.lng })}
                    onAction={onActionVoid}
                  />
                )}
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
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand-500 to-brand-700 text-white shadow-sm">
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
