import clsx from 'clsx'
import {
  Bell, BellRing, Building2, Camera, Check, FileText, Keyboard, LayoutDashboard, Loader2, Map as MapIcon, Mic, Radar,
  ShieldAlert, UserPlus, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ListenButton } from '../components/auth/ListenButton'
import { ROLE_META } from '../components/auth/meta'
import { ErrorBanner, Notice } from '../components/auth/parts'
import { AppHeader } from '../components/layout/AppHeader'
import { AiLabel, Button, CategoryIcon, EmptyState, Spinner, StatusBadge, UrgencyBadge, useTimeAgo } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { api } from '../lib/api'
import { CATEGORY_META } from '../lib/categories'
import { useI18n } from '../lib/i18n'
import { enablePush, pushSupported } from '../lib/push'
import { STATUS_META } from '../lib/status'
import { supabase } from '../lib/supabase'
import type { AppNotification, MyReport, ReportStatus } from '../lib/types'

// ---------------------------------------------------------------- data shapes
const REPORT_COLS = [
  'id', 'cluster_id', 'category', 'urgency', 'status', 'title_en', 'title_ur', 'summary_en', 'summary_ur', 'transcript',
  'language', 'address_text', 'created_at', 'confidence', 'ai_reason', 'is_spam', 'spam_reason', 'food_servings',
  'safe_until', 'input_modes',
] as const
const REPORT_SELECT = REPORT_COLS.join(', ')
/** Own report row; cluster_id is null for reports rejected as spam. */
type ReportRow = Omit<MyReport, 'cluster_id'> & { cluster_id: string | null; spam_reason: string | null }

function pickReport(raw: Record<string, unknown>): Partial<ReportRow> {
  const out: Record<string, unknown> = {}
  for (const k of REPORT_COLS) if (k in raw) out[k] = raw[k]
  return out as Partial<ReportRow>
}

const TRACK: ReportStatus[] = ['unconfirmed', 'verified', 'in_progress', 'resolved']
const MODE_ICON: Record<string, LucideIcon> = { voice: Mic, photo: Camera, text: Keyboard }
const NEARBY_KEY = 'awaaz.nearbyAlerts'

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}
function writeFlag(key: string, on: boolean) {
  try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key) } catch { /* storage unavailable */ }
}
function vibrate(pattern: number[]) {
  try { navigator.vibrate?.(pattern) } catch { /* not supported */ }
}
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject({ code: 2 }); return }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 12000, maximumAge: 120000 })
  })
}
async function geoPermission(): Promise<PermissionState | 'unknown'> {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state } catch { return 'unknown' }
}

/** Whole-card tap target (a div, so the nested Listen button stays valid HTML). */
function clickable(onOpen?: () => void) {
  if (!onOpen) return {}
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
    },
  }
}

// ---------------------------------------------------------------- small pieces
function Switch({ on, busy, onToggle, label }: { on: boolean; busy?: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle} disabled={busy}
      className={clsx(
        'inline-flex h-12 w-20 shrink-0 items-center rounded-full p-1 transition disabled:opacity-70',
        on ? 'justify-end bg-green-600' : 'justify-start bg-slate-300',
      )}
    >
      <span className="inline-flex size-10 items-center justify-center rounded-full bg-white shadow">
        {busy ? <Loader2 className="size-5 animate-spin text-slate-500" /> : on ? <Check className="size-5 text-green-600" /> : null}
      </span>
    </button>
  )
}

function SettingRow({ icon: Icon, color, title, body, children }: { icon: LucideIcon; color: string; title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: color }}>
        <Icon className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold leading-tight">{title}</div>
        <div className="text-sm text-slate-600">{body}</div>
      </div>
      {children}
    </div>
  )
}

type PushState = 'default' | 'granted' | 'denied' | 'unsupported' | 'error' | 'busy'

function initialPushState(): PushState {
  if (!pushSupported() || typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return 'default'
}

function PushRow() {
  const { t } = useI18n()
  const [state, setState] = useState<PushState>(initialPushState)

  // permission already granted: make sure this device's token is registered to the CURRENT user
  useEffect(() => {
    if (initialPushState() === 'granted') void enablePush().catch(() => undefined)
  }, [])

  async function turnOn() {
    setState('busy')
    try {
      const r = await enablePush()
      setState(r === 'granted' ? 'granted' : r)
      if (r === 'granted') vibrate([60])
    } catch {
      setState('error')
    }
  }

  const body = state === 'denied' ? t('auth.pushDenied')
    : state === 'unsupported' ? t('auth.pushUnsupported')
    : state === 'error' ? t('auth.pushError')
    : t('auth.pushBody')

  return (
    <SettingRow icon={BellRing} color="#0F766E" title={t('auth.pushTitle')} body={body}>
      {state === 'granted' ? (
        <span className="inline-flex min-h-12 items-center gap-1 rounded-full bg-green-100 px-4 font-bold text-green-700">
          <Check className="size-5" /> {t('auth.pushOn')}
        </span>
      ) : state === 'default' || state === 'error' || state === 'busy' ? (
        <Button size="md" loading={state === 'busy'} onClick={turnOn}>{t('auth.pushTurnOn')}</Button>
      ) : null}
    </SettingRow>
  )
}

function NearbyRow({ uid }: { uid: string }) {
  const { t } = useI18n()
  const [on, setOn] = useState(() => readFlag(NEARBY_KEY))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const sync = useCallback(async () => {
    const p = await getPosition()
    await api.updateMyLocation(p.coords.latitude, p.coords.longitude)
  }, [])

  // keep the server-side location fresh (nearby alerts only use locations from the last 48 h) — never prompts
  useEffect(() => {
    if (!readFlag(NEARBY_KEY)) return
    void (async () => {
      if ((await geoPermission()) === 'granted') await sync().catch(() => undefined)
    })()
  }, [sync])

  async function toggle() {
    setError(null)
    if (on) {
      setOn(false)
      writeFlag(NEARBY_KEY, false)
      // best effort: forget the stored location so no nearby alerts are sent
      await supabase.from('profiles').update({ last_location: null, last_location_at: null }).eq('id', uid)
      return
    }
    setBusy(true)
    try {
      await sync()
      setOn(true)
      writeFlag(NEARBY_KEY, true)
      vibrate([60])
    } catch (e) {
      const code = (e as { code?: number })?.code
      setError(code === 1 ? 'auth.gpsDenied' : code === 2 || code === 3 ? 'auth.gpsUnavailable' : e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingRow icon={Radar} color={CATEGORY_META.hazard.color} title={t('auth.nearbyTitle')} body={on ? t('auth.nearbyOn') : t('auth.nearbyBody')}>
        <Switch on={on} busy={busy} onToggle={() => { void toggle() }} label={t('auth.nearbyTitle')} />
      </SettingRow>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
    </>
  )
}

/** Icon-only 4-step tracker: sent → verified → working → resolved. */
function ProgressTrack({ status }: { status: ReportStatus }) {
  const { t, lang } = useI18n()
  const idx = TRACK.indexOf(status)
  const disputed = status === 'disputed'
  return (
    <ol className="flex items-center" aria-label={t('auth.progress')}>
      {TRACK.map((s, i) => {
        const m = STATUS_META[s]
        const Icon = m.icon
        const reached = !disputed && i <= idx
        const isCurrent = !disputed && i === idx
        return (
          <li key={s} className={clsx('flex items-center', i < TRACK.length - 1 && 'flex-1')}>
            <span
              title={lang === 'ur' ? m.ur : m.en}
              aria-label={lang === 'ur' ? m.ur : m.en}
              aria-current={isCurrent ? 'step' : undefined}
              className={clsx('inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2', isCurrent && 'ring-4')}
              style={reached
                ? { background: m.color, borderColor: m.color, color: '#fff', ['--tw-ring-color' as string]: m.soft }
                : { background: '#fff', borderColor: '#CBD5E1', color: '#94A3B8' }}
            >
              <Icon className="size-4" />
            </span>
            {i < TRACK.length - 1 && (
              <span className="mx-1 h-1 flex-1 rounded-full" style={{ background: !disputed && i < idx ? STATUS_META[TRACK[i + 1]].color : '#E2E8F0' }} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function ReportCard({ r, flash, onOpen }: { r: ReportRow; flash: boolean; onOpen?: () => void }) {
  const { t, pick, lang } = useI18n()
  const ago = useTimeAgo()
  const title = pick(r.title_en, r.title_ur) || pick(CATEGORY_META[r.category]?.en, CATEGORY_META[r.category]?.ur)
  const summary = pick(r.summary_en, r.summary_ur)
  const statusLabel = lang === 'ur' ? STATUS_META[r.status]?.ur : STATUS_META[r.status]?.en
  return (
    <li>
      <div
        {...clickable(onOpen)}
        className={clsx(
          'block w-full rounded-3xl bg-white p-3 text-start shadow-sm ring-1 transition',
          onOpen && 'cursor-pointer active:scale-[0.99]',
          flash ? 'bg-green-50 ring-4 ring-green-400' : 'ring-slate-200',
        )}
      >
        <div className="flex items-start gap-3">
          <CategoryIcon category={r.category} size={48} />
          <div className="min-w-0 flex-1">
            <div className="font-bold leading-snug">{title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>{ago(r.created_at)}</span>
              <span className="inline-flex items-center gap-1">
                {(r.input_modes ?? []).map((mode) => {
                  const I = MODE_ICON[mode]
                  return I ? <I key={mode} className="size-4" aria-label={t(`auth.mode_${mode}`)} /> : null
                })}
              </span>
            </div>
          </div>
          <ListenButton text={[title, summary, statusLabel].filter(Boolean).join('. ')} />
        </div>

        {r.is_spam ? (
          <div className="mt-2 flex items-start gap-2 rounded-2xl bg-slate-100 p-2 text-sm text-slate-700">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-slate-500" />
            <div>
              <div className="font-semibold">{t('auth.rejected')}</div>
              {r.spam_reason && <div className="text-xs">{r.spam_reason}</div>}
            </div>
          </div>
        ) : (
          <>
            {summary && <p className="mt-2 line-clamp-2 text-sm text-slate-700">{summary}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={r.status} />
              <UrgencyBadge urgency={r.urgency} />
              <AiLabel />
              {r.confidence > 0 && <span className="text-xs font-semibold text-slate-500">{t('common.confidence', { n: Math.round(r.confidence * 100) })}</span>}
              {flash && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-600 px-2 py-0.5 text-xs font-bold text-white">
                  <Bell className="size-3" /> {t('auth.statusUpdated')}
                </span>
              )}
            </div>
            {r.category === 'food' && (r.food_servings || r.safe_until) && (
              <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold" style={{ color: CATEGORY_META.food.color }}>
                {r.food_servings ? <span className="rounded-full px-2 py-0.5" style={{ background: CATEGORY_META.food.soft }}>{t('auth.servings', { n: r.food_servings })}</span> : null}
                {r.safe_until ? (
                  <span className="rounded-full px-2 py-0.5" style={{ background: CATEGORY_META.food.soft }}>
                    {t('auth.safeUntil', { time: new Date(r.safe_until).toLocaleTimeString(lang === 'ur' ? 'ur-PK' : 'en-PK', { hour: 'numeric', minute: '2-digit' }) })}
                  </span>
                ) : null}
              </div>
            )}
            <div className="mt-3"><ProgressTrack status={r.status} /></div>
          </>
        )}
      </div>
    </li>
  )
}

const NOTIF_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  new_assignment: { icon: ROLE_META.responder.icon, color: ROLE_META.responder.color },
  nearby_alert: { icon: Radar, color: CATEGORY_META.hazard.color },
  food_alert: { icon: CATEGORY_META.food.icon, color: CATEGORY_META.food.color },
  verified: { icon: STATUS_META.verified.icon, color: STATUS_META.verified.color },
}

function notifVisual(n: AppNotification) {
  if (n.type === 'status_change') {
    const s = (n.data?.status ?? n.data?.cluster_status) as ReportStatus | undefined
    if (s && STATUS_META[s]) return { icon: STATUS_META[s].icon, color: STATUS_META[s].color }
  }
  return NOTIF_ICON[n.type] ?? { icon: Bell, color: '#475569' }
}

function NotificationItem({ n, fresh, onOpen }: { n: AppNotification; fresh: boolean; onOpen?: () => void }) {
  const { t, pick } = useI18n()
  const ago = useTimeAgo()
  const v = notifVisual(n)
  const Icon = v.icon
  const title = pick(n.title_en, n.title_ur)
  const body = pick(n.body_en, n.body_ur)
  return (
    <li>
      <div
        {...clickable(onOpen)}
        className={clsx('flex w-full items-start gap-3 rounded-3xl p-3 text-start shadow-sm ring-1', onOpen && 'cursor-pointer', fresh ? 'bg-amber-50 ring-amber-300' : 'bg-white ring-slate-200')}
      >
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: v.color }}>
          <Icon className="size-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-bold leading-snug">{title}</span>
            {fresh && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">{t('auth.newBadge')}</span>}
          </span>
          {body && <span className="mt-0.5 block text-sm text-slate-700">{body}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {ago(n.created_at)}
            {n.type !== 'status_change' && <AiLabel />}
          </span>
        </span>
        <ListenButton text={[title, body].filter(Boolean).join('. ')} />
      </div>
    </li>
  )
}

// ---------------------------------------------------------------- page
type Tab = 'reports' | 'alerts'

export default function MePage() {
  const { t } = useI18n()
  const { user, profile, role, isAnonymous, orgs } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const uid = user?.id
  const tab: Tab = params.get('tab') === 'alerts' ? 'alerts' : 'reports'

  const [reports, setReports] = useState<ReportRow[] | null>(null)
  const [notifs, setNotifs] = useState<AppNotification[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [flash, setFlash] = useState<Record<string, true>>({})
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set())
  const [live, setLive] = useState(false)
  const reportsRef = useRef<ReportRow[] | null>(null)
  useEffect(() => { reportsRef.current = reports }, [reports])

  const flashRow = useCallback((id: string, status: ReportStatus) => {
    setFlash((f) => ({ ...f, [id]: true }))
    vibrate(status === 'resolved' ? [120, 60, 120] : [80])
    setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[id]; return n }), 6000)
  }, [])

  // initial load
  useEffect(() => {
    if (!uid) return
    let alive = true
    void (async () => {
      const [r, n] = await Promise.all([
        supabase.from('reports').select(REPORT_SELECT).eq('reporter_id', uid).order('created_at', { ascending: false }).limit(50),
        supabase.from('notifications').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(40),
      ])
      if (!alive) return
      if (r.error) setError(r.error)
      setReports((r.data as unknown as ReportRow[] | null) ?? [])
      setNotifs((n.data as AppNotification[] | null) ?? [])
    })()
    return () => { alive = false }
  }, [uid])

  // realtime: own reports (status changes appear live) + own notifications
  useEffect(() => {
    if (!uid) return
    const ch = supabase
      .channel(`me-${uid}-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'reports', filter: `reporter_id=eq.${uid}`,
      }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string }).id
          if (id) setReports((prev) => prev?.filter((x) => x.id !== id) ?? prev)
          return
        }
        const row = pickReport(payload.new as Record<string, unknown>)
        const id = row.id
        if (!id) return
        const existing = reportsRef.current?.find((x) => x.id === id)
        if (!existing) {
          // new report (e.g. submitted from another tab): fetch the clean row
          void supabase.from('reports').select(REPORT_SELECT).eq('id', id).maybeSingle().then(({ data }) => {
            if (data) setReports((prev) => (prev?.some((x) => x.id === id) ? prev : [data as unknown as ReportRow, ...(prev ?? [])]))
          })
          return
        }
        if (row.status && row.status !== existing.status) flashRow(id, row.status)
        setReports((prev) => prev?.map((x) => (x.id === id ? { ...x, ...row } : x)) ?? prev)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, (payload) => {
        const n = payload.new as AppNotification
        if (!n?.id) return
        setNotifs((prev) => (prev?.some((x) => x.id === n.id) ? prev : [n, ...(prev ?? [])]))
        vibrate([80])
      })
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))
    return () => { void supabase.removeChannel(ch) }
  }, [uid, flashRow])

  // mark notifications read once the Alerts tab is on screen (keep a "New" badge for this visit)
  useEffect(() => {
    if (tab !== 'alerts' || !notifs) return
    const unread = notifs.filter((n) => !n.read_at).map((n) => n.id)
    if (!unread.length) return
    const id = setTimeout(() => {
      const now = new Date().toISOString()
      setFreshIds((prev) => new Set([...prev, ...unread]))
      setNotifs((prev) => prev?.map((n) => (unread.includes(n.id) ? { ...n, read_at: now } : n)) ?? prev)
      void supabase.from('notifications').update({ read_at: now }).in('id', unread)
    }, 700)
    return () => clearTimeout(id)
  }, [tab, notifs])

  const unreadCount = notifs?.filter((n) => !n.read_at).length ?? 0
  const setTab = (next: Tab) => setParams(next === 'alerts' ? { tab: 'alerts' } : {}, { replace: true })
  const roleMeta = ROLE_META[role ?? 'citizen']
  const RoleIcon = roleMeta.icon
  const displayName = isAnonymous ? t('auth.guest') : profile?.display_name || user?.email || t('auth.guest')
  const isOrgRole = role === 'ngo' || role === 'responder'

  function openNotification(n: AppNotification) {
    const url = typeof n.data?.url === 'string' ? n.data.url : null
    if (url && url.startsWith('/')) nav(url)
    else if (n.cluster_id) nav(`/pin/${n.cluster_id}`)
  }

  return (
    <div className="min-h-full bg-slate-50">
      <AppHeader />
      <main className="mx-auto max-w-xl space-y-4 px-4 py-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {/* who am I */}
        <section className="flex items-center gap-3 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
          <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: roleMeta.color }}>
            <RoleIcon className="size-7" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold">{displayName}</div>
            <div className="text-sm font-semibold" style={{ color: roleMeta.color }}>{t(`auth.role_${role ?? 'citizen'}`)}</div>
          </div>
        </section>

        {isAnonymous && (
          <Notice tone="warn" icon={UserPlus}>
            <div className="text-sm">{t('auth.guestHint')}</div>
            <Button size="sm" icon={UserPlus} className="mt-2" onClick={() => nav('/login?tab=signup')}>{t('auth.createAccount')}</Button>
          </Notice>
        )}

        {(isOrgRole || role === 'admin') && (
          <div className="grid grid-cols-2 gap-2">
            {isOrgRole && (
              <Button variant="secondary" icon={Building2} onClick={() => nav('/org/register')}>
                {t('auth.myOrgs')}{orgs.length ? ` (${orgs.length})` : ''}
              </Button>
            )}
            <Button variant="secondary" icon={LayoutDashboard} onClick={() => nav('/dashboard')} className={clsx(!isOrgRole && 'col-span-2')}>
              {t('auth.openDashboard')}
            </Button>
          </div>
        )}

        {/* alert settings */}
        <section className="rounded-3xl bg-white px-3 py-1 shadow-sm ring-1 ring-slate-200" aria-label={t('auth.settings')}>
          <PushRow />
          <div className="h-px bg-slate-100" />
          {uid && <NearbyRow uid={uid} />}
        </section>

        {/* tabs */}
        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-200/70 p-1">
          {([['reports', FileText, t('auth.myReportsTab'), 0], ['alerts', Bell, t('auth.alertsTab'), unreadCount]] as const).map(([id, Icon, label, badge]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={clsx('relative inline-flex min-h-12 items-center justify-center gap-2 rounded-xl font-bold transition',
                tab === id ? 'bg-white text-brand-700 shadow' : 'text-slate-600')}>
              <Icon className="size-5" /> {label}
              {badge > 0 && <span className="font-latin inline-flex min-w-6 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">{badge}</span>}
            </button>
          ))}
        </div>
        {live && (
          <div className="-mt-2 flex items-center justify-end gap-1.5 text-xs font-semibold text-green-700">
            <span className="size-2 rounded-full bg-green-500" /> {t('auth.live')}
          </div>
        )}

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {tab === 'reports' ? (
          reports === null ? (
            <div className="flex justify-center py-10 text-brand-700"><Spinner className="size-8" /></div>
          ) : reports.length === 0 ? (
            <EmptyState icon={Mic} title={t('auth.noReports')}>
              <p className="text-sm">{t('auth.noReportsBody')}</p>
              <Button size="lg" icon={Mic} className="mt-3" onClick={() => nav('/map')}>{t('auth.reportNow')}</Button>
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {reports.map((r) => (
                <ReportCard key={r.id} r={r} flash={Boolean(flash[r.id])} onOpen={r.cluster_id ? () => nav(`/pin/${r.cluster_id}`) : undefined} />
              ))}
            </ul>
          )
        ) : notifs === null ? (
          <div className="flex justify-center py-10 text-brand-700"><Spinner className="size-8" /></div>
        ) : notifs.length === 0 ? (
          <EmptyState icon={Bell} title={t('auth.noAlerts')}>
            <p className="text-sm">{t('auth.noAlertsBody')}</p>
            <Button variant="secondary" icon={MapIcon} className="mt-3" onClick={() => nav('/map')}>{t('auth.openMap')}</Button>
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {notifs.map((n) => (
              <NotificationItem key={n.id} n={n} fresh={!n.read_at || freshIds.has(n.id)}
                onOpen={n.cluster_id || typeof n.data?.url === 'string' ? () => openNotification(n) : undefined} />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
