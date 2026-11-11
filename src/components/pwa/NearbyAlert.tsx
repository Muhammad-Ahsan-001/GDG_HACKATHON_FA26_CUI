import clsx from 'clsx'
import {
  ChevronDown, CircleCheck, CircleX, Hand, Loader2, LocateFixed, MapPinned, Navigation, Radar, Square, Volume2, X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { distanceM } from '../../hooks/useGeolocation'
import { api } from '../../lib/api'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { AppNotification, Category, Lang, MapPin, Profile, Role } from '../../lib/types'
import { buzz, canAutoplay, playUrl, stopVoice, useVoicePlaying } from '../../lib/voice/player'
import { FoodLine } from '../food/FoodPanel'
import { nearbyNavState } from '../food/NearbyPinBanner'
import { useFormatDistance } from '../map/useFormatDistance'
import { UrgencyBadge } from '../ui'
import { VoiceGuide } from '../voice/VoiceGuide'
import { dismissToast, useToasts } from './toast'

// ---------------------------------------------------------------------------------------------------------------
// Nearby danger alerts + food rescue alerts, app-wide (mounted in <PwaLayer/>).
//  - Realtime INSERTs on the user's own `notifications` rows: 'nearby_alert' (citizens within 1 km of a verified
//    high-urgency pin, or a free-food offer) and, for NGO users, 'food_alert' (surplus food routed to their org).
//  - Prominent but non-blocking top card: category icon + colour, bilingual text, distance, "View on map", dismiss;
//    vibrates and reads the alert aloud (TTS) — never on /sos (SOS is silent and private) or during onboarding.
//  - Citizens without a recently shared location get a small once-a-day chip on /map and /me to turn alerts on.
// ---------------------------------------------------------------------------------------------------------------

type PinLite = Pick<MapPin, 'id' | 'category' | 'urgency' | 'status' | 'lat' | 'lng' | 'food_servings' | 'food_type' | 'safe_until'>
type Fix = { lat: number; lng: number }

interface AlertItem {
  n: AppNotification
  category: Category
  pin: PinLite | null
  distance: number | null
  /** arrived while the app was open on a screen that may speak (false = catch-up on launch / after SOS) */
  live: boolean
}

const ALERT_TYPES = ['nearby_alert', 'food_alert'] as const
const CATCH_UP_HOURS = 3
const COLLAPSE_AFTER_MS = 30_000
const LOCATION_FRESH_MS = 48 * 3600_000
const SILENT_REFRESH_MS = 6 * 3600_000
const CHIP_DELAY_MS = 6000
const LS_CHIP_DAY = 'awaaz.nearby.chipDay'
const LS_LOC_AT = 'awaaz.nearby.locAt'

/** Screens where no alert UI may appear: SOS must stay silent and private; onboarding is a focused flow. */
const isQuietRoute = (path: string) => path.startsWith('/sos') || path.startsWith('/onboarding')

function readLs(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeLs(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}
const today = () => new Date().toISOString().slice(0, 10)

// ---- location helpers (never trigger a permission prompt except from the chip's button) ----
let lastFix: (Fix & { at: number }) | null = null

async function geoPermission(): Promise<PermissionState | 'unknown'> {
  try {
    if (!navigator.permissions?.query) return 'unknown'
    const st = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
    return st.state
  } catch {
    return 'unknown'
  }
}

function getPosition(timeout: number): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('unsupported')); return }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lng: p.coords.longitude }
        lastFix = { ...fix, at: Date.now() }
        resolve(fix)
      },
      (e) => reject(e),
      { enableHighAccuracy: false, timeout, maximumAge: 5 * 60_000 },
    )
  })
}

/** The user's position for the distance chip — only when permission is already granted (or a recent fix exists). */
async function quietFix(): Promise<Fix | null> {
  if (lastFix && Date.now() - lastFix.at < 10 * 60_000) return lastFix
  if ((await geoPermission()) !== 'granted') return lastFix
  try { return await getPosition(6000) } catch { return lastFix }
}

async function fetchPin(clusterId: string | null): Promise<PinLite | null> {
  if (!clusterId) return null
  const { data, error } = await supabase
    .from('map_pins')
    .select('id, category, urgency, status, lat, lng, food_servings, food_type, safe_until')
    .eq('id', clusterId)
    .maybeSingle()
  return error ? null : ((data as PinLite | null) ?? null)
}

function markRead(id: string): void {
  void supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null)
    .then(({ error }) => { if (error) console.warn('[nearby] mark read failed', error.message) })
}

function categoryOf(n: AppNotification, pin: PinLite | null): Category {
  if (pin?.category) return pin.category
  const c = n.data?.category
  if (typeof c === 'string' && c in CATEGORY_META) return c as Category
  return n.type === 'food_alert' ? 'food' : 'hazard'
}

function wanted(n: AppNotification, role: Role | null, path: string): boolean {
  if (n.type === 'nearby_alert') return true
  // NGO food rescue — but the dashboard already shows its own banner + beep for new cases
  if (n.type === 'food_alert') return role === 'ngo' && !path.startsWith('/dashboard')
  return false
}

// =================================================================================================================
export function NearbyAlert() {
  const { user, role, profile } = useAuth()
  const { pathname } = useLocation()
  const uid = user?.id ?? null
  const quiet = isQuietRoute(pathname)

  const [queue, setQueue] = useState<AlertItem[]>([])
  const seen = useRef(new Set<string>())
  const ctx = useRef({ uid, role, pathname, quiet })
  useEffect(() => { ctx.current = { uid, role, pathname, quiet } }, [uid, role, pathname, quiet])

  // new user → forget the previous user's alerts
  useEffect(() => {
    setQueue([])
    seen.current = new Set()
  }, [uid])

  const handle = useCallback(async (n: AppNotification, live: boolean) => {
    if (!n?.id || seen.current.has(n.id)) return
    seen.current.add(n.id)
    const { uid: forUid, role: r, pathname: path, quiet: q } = ctx.current
    if (!wanted(n, r, path)) return
    // the user is already looking at this pin (e.g. they tapped the push notification)
    if (n.cluster_id && path === `/pin/${n.cluster_id}`) { markRead(n.id); return }
    const insert = (item: AlertItem) => setQueue((cur) => [
      item,
      ...cur.filter((x) => x.n.id !== n.id && (!n.cluster_id || x.n.cluster_id !== n.cluster_id)),
    ].slice(0, 5))
    // update only — an alert the user already dismissed must not come back
    const patch = (p: Partial<AlertItem>) => setQueue((cur) => cur.map((x) => (x.n.id === n.id ? { ...x, ...p } : x)))
    const base: AlertItem = { n, category: categoryOf(n, null), pin: null, distance: null, live: live && !q }
    // live: show the card at once (category comes with the notification), then enrich it
    if (live) insert(base)
    const pin = await fetchPin(n.cluster_id)
    if (ctx.current.uid !== forUid) return // signed out / switched account meanwhile
    if (live) patch({ pin, category: categoryOf(n, pin) })
    else if (pin) insert({ ...base, pin, category: categoryOf(n, pin) })
    else return // catch-up alert whose pin has left the map (resolved / food expired): no longer useful
    if (!pin) return
    const fix = await quietFix()
    if (fix && ctx.current.uid === forUid) patch({ distance: distanceM(fix, pin) })
  }, [])

  // realtime: own notifications
  useEffect(() => {
    if (!uid) return
    const ch = supabase
      .channel(`nearby-${uid}-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` },
        (payload) => { void handle(payload.new as AppNotification, true) })
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [uid, handle])

  // catch-up: unread alerts from the last few hours (app was closed / opened from a push); waits for the role
  useEffect(() => {
    if (!uid || !role) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const since = new Date(Date.now() - CATCH_UP_HOURS * 3600_000).toISOString()
      void supabase
        .from('notifications')
        .select('*')
        .eq('user_id', uid)
        .in('type', [...ALERT_TYPES])
        .is('read_at', null)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(3)
        .then(({ data }) => {
          if (cancelled) return
          for (const n of (data ?? []) as AppNotification[]) void handle(n, false)
        })
    }, 1500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [uid, role, handle])

  // the foreground-push toast (<Toaster/>) says the same thing — keep only this richer card
  const toasts = useToasts()
  useEffect(() => {
    if (quiet || !queue.length || !toasts.length) return
    for (const tt of toasts) {
      const dup = queue.some((it) => (it.n.cluster_id && tt.url === `/pin/${it.n.cluster_id}`)
        || tt.title === it.n.title_en || tt.title === it.n.title_ur)
      if (dup) dismissToast(tt.id)
    }
  }, [toasts, queue, quiet])

  const dismiss = useCallback((id: string) => {
    setQueue((cur) => cur.filter((x) => x.n.id !== id))
  }, [])

  const current = queue[0] ?? null
  const showChip = !current && !quiet && Boolean(uid) && role === 'citizen' && (pathname === '/map' || pathname === '/me')
  // profiles select('*') includes last_location_at (not in the shared Profile type)
  const lastSharedAt = (profile as (Profile & { last_location_at?: string | null }) | null)?.last_location_at ?? null

  if (quiet) return null
  return (
    <>
      {current && <AlertCard key={current.n.id} item={current} more={queue.length - 1} onDone={dismiss} />}
      {showChip && uid && <LocationChip uid={uid} lastSharedAt={lastSharedAt} />}
    </>
  )
}

// =================================================================================================================
function AlertCard({ item, more, onDone }: { item: AlertItem; more: number; onDone: (id: string) => void }) {
  const { t, lang, pick } = useI18n()
  const nav = useNavigate()
  const fmtDist = useFormatDistance()
  const { n, pin, distance, category } = item
  const cat = CATEGORY_META[category] ?? CATEGORY_META.other
  const Icon = cat.icon
  const isFoodOrg = n.type === 'food_alert'
  const isFood = category === 'food'
  const fallbackTitle = isFood ? t('alerts.nearby_foodTitle') : t('alerts.nearby_dangerTitle')
  const title = pick(n.title_en, n.title_ur) || fallbackTitle
  const body = pick(n.body_en, n.body_ur)
  const voiceKey = `nearby:${n.id}`
  const playing = useVoicePlaying() === voiceKey

  const [collapsed, setCollapsed] = useState(false)
  const [audio, setAudio] = useState<'idle' | 'loading' | 'error'>('idle')
  const collapseTimer = useRef<number | null>(null)
  const tts = useRef<{ key: string; url: string } | null>(null)

  const armCollapse = useCallback(() => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current)
    collapseTimer.current = window.setTimeout(() => setCollapsed(true), COLLAPSE_AFTER_MS)
  }, [])
  useEffect(() => {
    armCollapse()
    return () => { if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current) }
  }, [armCollapse])

  // viewed → mark read (after a moment on screen)
  useEffect(() => {
    const id = window.setTimeout(() => markRead(n.id), 1500)
    return () => window.clearTimeout(id)
  }, [n.id])

  const speak = useCallback(async (userAsked: boolean) => {
    if (isQuietRoute(window.location.pathname)) return
    const urText = [n.title_ur, n.body_ur].filter(Boolean).join('۔ ')
    const enText = [n.title_en, n.body_en].filter(Boolean).join('. ')
    const useUr = lang === 'ur' ? Boolean(urText) : !enText
    const text = useUr ? urText : enText
    const ttsLang: Lang = useUr ? 'ur' : 'en'
    if (!text) return
    // before the first tap on the page the browser blocks audio — don't spend a TTS call on it
    if (!userAsked && !canAutoplay()) return
    setAudio('loading')
    try {
      const key = `${ttsLang}|${text}`
      if (tts.current?.key !== key) tts.current = { key, url: (await api.tts(text, ttsLang)).url }
      setAudio('idle')
      if (isQuietRoute(window.location.pathname)) return
      await playUrl(tts.current.url, voiceKey)
    } catch {
      // TTS unavailable (e.g. AI key problem): the card + vibration still carry the alert
      setAudio(userAsked ? 'error' : 'idle')
    }
  }, [n.title_ur, n.body_ur, n.title_en, n.body_en, lang, voiceKey])

  // live alert: vibrate + read it aloud once
  const announced = useRef(false)
  useEffect(() => {
    if (!item.live || announced.current) return
    announced.current = true
    buzz(isFood ? [150, 80, 150] : [300, 120, 300, 120, 300])
    if (document.visibilityState === 'visible') void speak(false)
  }, [item.live, isFood, speak])

  // stop our clip when the card goes away (only if it is still ours that is playing)
  const playingRef = useRef(playing)
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => () => { if (playingRef.current) stopVoice() }, [])

  const done = (navigateTo?: { path: string; state?: unknown }) => {
    markRead(n.id)
    onDone(n.id)
    if (navigateTo) nav(navigateTo.path, { state: navigateTo.state })
  }
  const viewOnMap = () => done(n.cluster_id ? { path: `/pin/${n.cluster_id}`, state: nearbyNavState(distance, n.id) } : { path: '/map' })
  const openDashboard = () => {
    const assignmentId = typeof n.data?.assignment_id === 'string' ? n.data.assignment_id : undefined
    done({ path: '/dashboard', state: assignmentId ? { assignmentId } : undefined })
  }
  const toggleAudio = () => {
    armCollapse()
    if (playing) { stopVoice(); return }
    if (audio === 'loading') return
    void speak(true)
  }

  const distText = distance !== null ? t('alerts.nearby_away', { d: fmtDist(distance) }) : isFoodOrg ? null : t('alerts.nearby_within')
  const kicker = isFoodOrg ? t('alerts.nearby_foodKicker') : isFood ? t('alerts.nearby_freeFoodKicker') : t('alerts.nearby_kicker')
  const food = isFood && pin && (pin.food_servings != null || pin.food_type || pin.safe_until)

  if (collapsed) {
    return (
      <div
       
        className="pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-full bg-white p-1 shadow-lg ring-1 ring-black/5 transition-[opacity,translate] duration-200 starting:-translate-y-2 starting:opacity-0 motion-reduce:transition-none"
      >
        <button
          type="button"
          onClick={() => { setCollapsed(false); armCollapse() }}
          aria-label={`${title}. ${t('alerts.nearby_expand')}`}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-full ps-0.5 pe-2 text-start active:bg-slate-50"
        >
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white" style={{ background: cat.color }} aria-hidden>
            <Icon className="size-6" />
          </span>
          <span className="min-w-0 flex-1 truncate font-bold text-ink">{title}</span>
          {distance !== null && <span className="shrink-0 text-xs font-bold text-slate-600">{fmtDist(distance)}</span>}
          {more > 0 && <span className="font-latin shrink-0 rounded-full bg-slate-100 px-1.5 text-xs font-bold text-slate-600">+{more}</span>}
          <ChevronDown className="size-5 shrink-0 text-slate-400" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => done()}
          aria-label={t('alerts.nearby_dismiss')}
          title={t('alerts.nearby_dismiss')}
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
        >
          <X className="size-5" />
        </button>
      </div>
    )
  }

  return (
    <div
      role="alert"
     
      onPointerDown={armCollapse}
      className={clsx(
        'pointer-events-auto w-full max-w-md overflow-hidden rounded-3xl border-s-[6px] bg-white shadow-2xl ring-1 ring-black/5',
        'transition-[opacity,translate] duration-300 starting:-translate-y-4 starting:opacity-0 motion-reduce:transition-none',
      )}
      style={{ borderInlineStartColor: cat.color }}
    >
      <div className="flex items-start gap-3 p-3 pb-2">
        <span className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-full text-white" style={{ background: cat.color }} aria-hidden>
          <span className="absolute inset-0 rounded-full opacity-40 motion-safe:animate-ping" style={{ background: cat.color }} />
          <Icon className="relative size-8" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs font-black tracking-wide uppercase" style={{ color: cat.color }}>
            <Radar className="size-3.5" aria-hidden />
            <span>{kicker}</span>
            {pin && !isFood && <UrgencyBadge urgency={pin.urgency} />}
            {more > 0 && <span className="rounded-full bg-slate-100 px-1.5 text-slate-600">{t('alerts.nearby_more', { n: more })}</span>}
          </div>
          <div className="mt-0.5 text-[17px] leading-snug font-bold text-ink">{title}</div>
          {body && <p className="mt-0.5 line-clamp-3 text-sm leading-snug text-slate-600">{body}</p>}
          {(distText || food) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {distText && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm font-bold" style={{ background: cat.soft, color: cat.color }}>
                  <Navigation className="size-4" aria-hidden /> {distText}
                </span>
              )}
              {food && pin && <FoodLine servings={pin.food_servings} foodType={pin.food_type} safeUntil={pin.safe_until} />}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => done()}
          aria-label={t('alerts.nearby_dismiss')}
          title={t('alerts.nearby_dismiss')}
          className="-me-1 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
        >
          <X className="size-6" />
        </button>
      </div>

      {audio === 'error' && (
        <p role="status" className="mx-3 mb-2 rounded-xl bg-amber-50 px-2.5 py-1.5 text-sm font-semibold text-amber-800">{t('alerts.nearby_audioError')}</p>
      )}

      <div className="flex items-stretch gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={toggleAudio}
          aria-label={playing ? t('alerts.nearby_stop') : t('alerts.nearby_listen')}
          title={playing ? t('alerts.nearby_stop') : t('alerts.nearby_listen')}
          className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-amber-400 text-white shadow-sm transition active:scale-95"
        >
          {audio === 'loading' ? <Loader2 className="size-7 animate-spin" /> : playing ? <Square className="size-6" /> : <Volume2 className="size-7" />}
          {playing && <span className="absolute inset-0 rounded-2xl bg-amber-400/40 motion-safe:animate-ping" aria-hidden />}
        </button>
        {isFoodOrg && (
          <button
            type="button"
            onClick={openDashboard}
            className="inline-flex min-h-14 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl px-3 text-base leading-tight font-bold text-white shadow-sm transition active:scale-[0.98]"
            style={{ background: CATEGORY_META.food.color }}
          >
            <Hand className="size-6 shrink-0" aria-hidden />
            <span className="min-w-0">{t('alerts.nearby_claim')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={viewOnMap}
          className={clsx(
            'inline-flex min-h-14 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl px-3 text-base leading-tight font-bold shadow-sm transition active:scale-[0.98]',
            isFoodOrg ? 'border-2 bg-white' : 'text-white',
          )}
          style={isFoodOrg ? { borderColor: cat.color, color: cat.color } : { background: cat.color }}
        >
          <MapPinned className="size-6 shrink-0" aria-hidden />
          <span className="min-w-0">{t('alerts.nearby_viewOnMap')}</span>
        </button>
      </div>
    </div>
  )
}

// =================================================================================================================
/** "Get alerts about danger near you" — once a day for citizens whose location is not shared (or is stale). */
function LocationChip({ uid, lastSharedAt }: { uid: string; lastSharedAt: string | null }) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<'hidden' | 'ask' | 'working' | 'ok' | 'denied' | 'error'>('hidden')
  const decided = useRef<string | null>(null)

  useEffect(() => {
    if (decided.current === uid) return
    decided.current = uid
    const shared = Math.max(
      lastSharedAt ? new Date(lastSharedAt).getTime() || 0 : 0,
      Number(readLs(`${LS_LOC_AT}:${uid}`)) || 0,
    )
    let cancelled = false
    void (async () => {
      const perm = await geoPermission()
      if (cancelled || perm === 'denied') return
      if (perm === 'granted') {
        // already allowed: keep the shared location fresh silently (feeds nearby alerts), no chip
        if (Date.now() - shared < SILENT_REFRESH_MS) return
        try {
          const f = await getPosition(10_000)
          await api.updateMyLocation(f.lat, f.lng)
          writeLs(`${LS_LOC_AT}:${uid}`, String(Date.now()))
        } catch { /* harmless */ }
        return
      }
      if (Date.now() - shared < LOCATION_FRESH_MS) return
      if (readLs(LS_CHIP_DAY) === today()) return
      await new Promise((r) => setTimeout(r, CHIP_DELAY_MS))
      if (cancelled) return
      writeLs(LS_CHIP_DAY, today())
      setPhase('ask')
    })()
    return () => { cancelled = true }
  }, [uid, lastSharedAt])

  // result messages fade away on their own
  useEffect(() => {
    if (phase !== 'ok' && phase !== 'denied' && phase !== 'error') return
    const id = window.setTimeout(() => setPhase('hidden'), phase === 'ok' ? 3500 : 5500)
    return () => window.clearTimeout(id)
  }, [phase])

  const turnOn = async () => {
    setPhase('working')
    try {
      const f = await getPosition(12_000)
      await api.updateMyLocation(f.lat, f.lng)
      writeLs(`${LS_LOC_AT}:${uid}`, String(Date.now()))
      buzz(40)
      setPhase('ok')
    } catch (e) {
      const denied = typeof e === 'object' && e !== null && 'code' in e && (e as GeolocationPositionError).code === 1
      setPhase(denied ? 'denied' : 'error')
    }
  }

  if (phase === 'hidden') return null

  if (phase === 'ok' || phase === 'denied' || phase === 'error') {
    const ok = phase === 'ok'
    const ResultIcon = ok ? CircleCheck : CircleX
    return (
      <div role="status" className={clsx(
        'pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-2xl px-3 py-2.5 text-sm font-semibold shadow-lg',
        ok ? 'bg-green-50 text-green-800 ring-1 ring-green-200' : 'bg-amber-50 text-amber-900 ring-1 ring-amber-200',
      )}>
        <ResultIcon className="size-6 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          {ok ? t('alerts.nearby_locOk') : phase === 'denied' ? t('alerts.nearby_locDenied') : t('alerts.nearby_locError')}
        </span>
      </div>
    )
  }

  const working = phase === 'working'
  return (
    <div className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-full bg-white p-1.5 shadow-lg ring-1 ring-black/5 transition-[opacity,translate] duration-300 starting:-translate-y-2 starting:opacity-0 motion-reduce:transition-none">
      <VoiceGuide prompt="location" size={44} label={false} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug font-bold text-ink">
          {working ? t('alerts.nearby_locWorking') : t('alerts.nearby_locTitle')}
        </span>
        {!working && <span className="block truncate text-xs text-slate-500">{t('alerts.nearby_locWhy')}</span>}
      </span>
      <button
        type="button"
        onClick={() => void turnOn()}
        disabled={working}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-brand-700 px-3.5 text-sm font-bold text-white transition active:scale-95 disabled:opacity-70"
      >
        {working ? <Loader2 className="size-5 animate-spin" /> : <LocateFixed className="size-5" />}
        {t('alerts.nearby_locCta')}
      </button>
      {!working && (
        <button
          type="button"
          onClick={() => setPhase('hidden')}
          aria-label={t('alerts.nearby_locDismiss')}
          title={t('alerts.nearby_locDismiss')}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
        >
          <X className="size-5" />
        </button>
      )}
    </div>
  )
}

export default NearbyAlert
