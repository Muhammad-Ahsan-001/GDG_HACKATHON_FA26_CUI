import clsx from 'clsx'
import type L from 'leaflet'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Marker, useMap } from 'react-leaflet'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { AppHeader } from '../components/layout/AppHeader'
import { ActionBar, LocateButton } from '../components/map/ActionBar'
import { CategoryFilter } from '../components/map/CategoryFilter'
import { CoachMark, coachSeen, markCoachSeen } from '../components/map/CoachMark'
import '../components/map/map.css'
import { BaseMap, ClusterLayer, InvalidateOnResize, type ClusterItem } from '../components/leaflet/BaseMap'
import { pinIcon, userDotIcon } from '../components/leaflet/icons'
import { PinSheet } from '../components/map/PinSheet'
import { SosButton } from '../components/sos/SosButton'
import { Spinner } from '../components/ui'
import { VoiceGuide } from '../components/voice/VoiceGuide'
import { config } from '../config'
import { useClusters } from '../hooks/useClusters'
import { useGeolocation, type GeoFix } from '../hooks/useGeolocation'
import { api } from '../lib/api'
import { URGENCY_META } from '../lib/categories'
import { useI18n } from '../lib/i18n'
import { stopVoice } from '../lib/voice/player'
import type { Category, MapPin, ProcessReportResponse } from '../lib/types'

// Report sheet (other builder) is code-split: the map paints first, the chunk is prefetched when idle.
const loadReportSheet = () => import('../components/report/ReportSheet')
const ReportSheet = lazy(() => loadReportSheet().then((m) => ({ default: m.ReportSheet })))

type ReportMode = 'voice' | 'photo' | 'text'
type LatLng = { lat: number; lng: number }

/** Cheap-phone heuristic: fewer cores / little RAM -> no pin pulse, fewer markers. */
const LOW_END = (() => {
  if (typeof navigator === 'undefined') return false
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return (typeof mem === 'number' && mem <= 2) || (navigator.hardwareConcurrency || 8) <= 4
})()
const MAX_MARKERS = LOW_END ? 250 : 400
const FILTER_KEY = 'awaaz.map.filter'
const LOCATION_PUSH_EVERY_MS = 5 * 60 * 1000

function parseMode(v: string | null): ReportMode {
  return v === 'photo' || v === 'text' || v === 'voice' ? v : 'voice'
}

function readFilter(): ReadonlySet<Category> {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY)
    if (raw) return new Set(JSON.parse(raw) as Category[])
  } catch { /* storage unavailable */ }
  return new Set()
}

/** Higher = more important to keep when the marker cap is hit. */
function priority(p: MapPin): number {
  const rank = URGENCY_META[p.urgency]?.rank ?? 1
  const active = p.status === 'resolved' ? 0 : p.status === 'disputed' ? 1 : 2
  return active * 10 + rank
}

/** Pan so the pin sits in the part of the map that the pin sheet doesn't cover. */
function panToPin(map: L.Map, p: LatLng, dir: 'rtl' | 'ltr') {
  const targetZoom = Math.max(map.getZoom(), 15) // >= 15: marker clustering is off, the pin is visible
  const mobile = window.innerWidth < 768
  // mobile: bottom sheet -> pin in the upper part; desktop: side panel on the inline-end side (440px)
  const dx = mobile ? 0 : dir === 'rtl' ? -220 : 220
  const dy = mobile ? Math.round(window.innerHeight * 0.22) : 0
  const pt = map.project([p.lat, p.lng], targetZoom).add([dx, dy])
  map.flyTo(map.unproject(pt, targetZoom), targetZoom, { duration: 0.6 })
}

/** Hands the Leaflet map instance up to the page (for locate / pan). */
function MapBridge({ onMap }: { onMap: (m: L.Map | null) => void }) {
  const map = useMap()
  useEffect(() => {
    onMap(map)
    return () => onMap(null)
  }, [map, onMap])
  return null
}

export default function MapPage() {
  const { t, dir } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const pinMatch = useMatch('/pin/:id')
  const [params] = useSearchParams()
  const selectedId = pinMatch?.params.id ?? null
  const isReport = location.pathname === '/report'
  // once opened, the report sheet stays mounted (toggled via `open`) so an unsent draft survives closing it
  const [reportMounted, setReportMounted] = useState(isReport)
  useEffect(() => { if (isReport) setReportMounted(true) }, [isReport])
  const reportMode = parseMode(params.get('mode'))

  // ---- data ----
  const [filter, setFilter] = useState<ReadonlySet<Category>>(readFilter)
  const filterList = useMemo(() => [...filter], [filter])
  const { pins, allPins, byId, loading, error, refresh, refreshPin, highlighted, live } = useClusters(filterList)

  useEffect(() => {
    try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(filterList)) } catch { /* ignore */ }
  }, [filterList])

  const counts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {}
    for (const p of allPins) c[p.category] = (c[p.category] ?? 0) + 1
    return c
  }, [allPins])

  const toggleCategory = useCallback((c: Category) => {
    setFilter((prev) => {
      const s = new Set(prev)
      if (s.has(c)) s.delete(c)
      else s.add(c)
      return s
    })
  }, [])
  const clearFilter = useCallback(() => setFilter(new Set()), [])

  // ---- map ----
  const [gmap, setGmap] = useState<L.Map | null>(null)
  const [view, setView] = useState<{ center: LatLng }>({ center: config.defaultCenter })
  const onMoveEnd = useCallback((c: LatLng) => { setView({ center: c }) }, [])

  // stable select handler so memoised markers don't re-render
  const navRef = useRef(navigate)
  useEffect(() => { navRef.current = navigate }, [navigate])
  const onSelect = useCallback((id: string) => { navRef.current('/pin/' + id) }, [])

  const visiblePins = useMemo(() => {
    let list = pins
    if (list.length > MAX_MARKERS) list = [...list].sort((a, c) => priority(c) - priority(a)).slice(0, MAX_MARKERS)
    if (selectedId && !list.some((p) => p.id === selectedId)) {
      const s = byId.get(selectedId)
      if (s) list = [...list, s]
    }
    return list
  }, [pins, selectedId, byId])

  const markerItems = useMemo<ClusterItem[]>(() => visiblePins.map((p) => {
    const rank = URGENCY_META[p.urgency]?.rank ?? 1
    const active = p.status !== 'resolved' && p.status !== 'disputed'
    const selected = p.id === selectedId
    return {
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      icon: pinIcon({
        category: p.category,
        status: p.status,
        urgency: p.urgency,
        count: p.report_count,
        selected,
        pulse: !LOW_END && rank >= 2 && (p.status === 'unconfirmed' || p.status === 'verified'),
        flash: highlighted.has(p.id),
      }),
      hot: active && rank >= 2,
      zIndexOffset: selected ? 100000 : (active ? 2000 : 0) + rank * 100,
    }
  }), [visiblePins, selectedId, highlighted])

  const selectedPin = selectedId ? byId.get(selectedId) ?? null : null

  // pan to the pin once per selection (also handles deep links once pins + map are ready)
  const pannedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId) { pannedFor.current = null; return }
    if (!gmap || !selectedPin || pannedFor.current === selectedId) return
    pannedFor.current = selectedId
    panToPin(gmap, selectedPin, dir)
  }, [gmap, selectedId, selectedPin, dir])

  // ---- location ----
  const geo = useGeolocation()
  const { locate } = geo
  const lastPushed = useRef(0)
  const pushLocation = useCallback((f: GeoFix) => {
    if (Date.now() - lastPushed.current < LOCATION_PUSH_EVERY_MS) return
    lastPushed.current = Date.now()
    // feeds "nearby" alerts; failures are harmless
    api.updateMyLocation(f.lat, f.lng).catch(() => { lastPushed.current = 0 })
  }, [])

  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current) }, [])

  const userAsked = useRef(false)
  const onLocate = useCallback(async () => {
    userAsked.current = true
    const f = await locate()
    if (!f) return
    pushLocation(f)
    gmap?.flyTo([f.lat, f.lng], Math.max(gmap.getZoom(), 15), { duration: 0.6 })
  }, [locate, gmap, pushLocation])

  useEffect(() => {
    if (!userAsked.current) return
    if (geo.state === 'denied') { userAsked.current = false; showToast(t('map.locationDenied')) }
    else if (geo.state === 'unavailable') { userAsked.current = false; showToast(t('map.locationUnavailable')) }
    else if (geo.state === 'ok') userAsked.current = false
  }, [geo.state, showToast, t])

  // quietly show the blue dot if location permission was already granted (no prompt)
  useEffect(() => {
    let cancelled = false
    const perms = navigator.permissions
    if (!perms?.query) return
    perms.query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (cancelled || s.state !== 'granted') return
        void locate().then((f) => { if (f && !cancelled) pushLocation(f) })
      })
      .catch(() => { /* Permissions API not supported for geolocation */ })
    return () => { cancelled = true }
  }, [locate, pushLocation])

  // ---- report flow ----
  useEffect(() => {
    const id = window.setTimeout(() => { void loadReportSheet().catch(() => {}) }, 2500)
    return () => window.clearTimeout(id)
  }, [])
  const goVoice = useCallback(() => { navRef.current('/report?mode=voice') }, [])
  const goPhoto = useCallback(() => { navRef.current('/report?mode=photo') }, [])
  const goText = useCallback(() => { navRef.current('/report?mode=text') }, [])
  const closeToMap = useCallback(() => { navRef.current('/map') }, [])
  const onReportDone = useCallback((res: ProcessReportResponse) => {
    if (res.cluster_id) {
      refreshPin(res.cluster_id)
      navRef.current('/pin/' + res.cluster_id)
    } else {
      navRef.current('/map')
    }
  }, [refreshPin])

  const fixLat = geo.fix?.lat
  const fixLng = geo.fix?.lng
  const userPos = useMemo(
    () => (fixLat !== undefined && fixLng !== undefined ? { lat: fixLat, lng: fixLng } : null),
    [fixLat, fixLng],
  )
  // ---- first-run coach mark on the mic (after onboarding: location.state.firstRun; otherwise once per device) ----
  const firstRun = Boolean((location.state as { firstRun?: boolean } | null)?.firstRun)
  const [coach, setCoach] = useState(() => firstRun || !coachSeen())
  const dismissCoach = useCallback(() => {
    markCoachSeen()
    setCoach(false)
    // drop the one-shot router state so a reload does not show the coach mark again
    if ((window.history.state as { usr?: { firstRun?: boolean } } | null)?.usr?.firstRun) {
      navRef.current(window.location.pathname + window.location.search, { replace: true, state: null })
    }
  }, [])
  const showCoach = coach && !isReport && !selectedId

  const showEmpty = !loading && !error && pins.length === 0 && !isReport && !selectedId && !showCoach

  return (
    <div className={clsx('awaaz-map-page relative h-dvh w-full overflow-hidden bg-slate-200', LOW_END && 'awaaz-lite')}>
      {/* ---------- map (Leaflet + OpenStreetMap, no key) ---------- */}
      <BaseMap className="absolute inset-0 z-0" onMoveEnd={onMoveEnd}>
        <InvalidateOnResize />
        <MapBridge onMap={setGmap} />
        <ClusterLayer items={markerItems} onSelect={onSelect} />
        {geo.fix && (
          <Marker
            position={[geo.fix.lat, geo.fix.lng]}
            icon={userDotIcon}
            interactive={false}
            keyboard={false}
            zIndexOffset={200000}
            title={t('map.youAreHere')}
          />
        )}
      </BaseMap>

      {/* ---------- top: header + filter chips; SOS (start) · status · voice help (end) ---------- */}
      <AppHeader floating />
      <div className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)_+_3.75rem)] z-20">
        <div className="pointer-events-auto">
          <CategoryFilter
            selected={filter}
            onToggle={toggleCategory}
            onAll={clearFilter}
            counts={counts}
            total={allPins.length}
          />
        </div>
        <div className="mt-2 flex items-start gap-2 px-3">
          {/* women's safety SOS: press-and-hold, deliberately far away from the report mic at the bottom.
              SOS is silent: touching it stops any voice guide that is playing. */}
          <span data-awaaz-sos="" className="pointer-events-auto inline-flex" onPointerDownCapture={stopVoice}>
            <SosButton size={60} className="[&>[role=status]]:start-0" />
          </span>
          <div className="flex min-w-0 flex-1 justify-center pt-1.5">
            {error && (
              <div role="alert" className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-full bg-white py-1 ps-3 pe-1 text-sm font-semibold text-red-700 shadow">
                <TriangleAlert className="size-5 shrink-0" />
                <span className="min-w-0 truncate">{t('map.loadError')}</span>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  aria-label={t('common.retry')}
                  title={t('common.retry')}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-red-50"
                >
                  <RefreshCw className="size-5" />
                </button>
              </div>
            )}
          </div>
          {/* "what is this screen?" — speaks mapIntro in the user's language */}
          <span data-awaaz-coach-keep="" className="pointer-events-auto mt-1.5 inline-flex">
            <VoiceGuide prompt="mapIntro" size={48} label={false} />
          </span>
        </div>
      </div>

      {/* ---------- bottom: live chip, locate, hints, action bar ---------- */}
      {!showCoach && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(max(1.75rem,env(safe-area-inset-bottom)_+_0.75rem)_+_8.25rem)] z-20 flex items-end justify-between gap-2 px-3">
          <span
            className="pointer-events-auto inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white/95 px-3 text-xs font-bold text-ink shadow-sm"
            title={live ? t('map.live') : undefined}
          >
            <span
              aria-hidden
              className={clsx('size-2.5 rounded-full', live ? 'bg-green-500' : 'bg-slate-400', highlighted.size > 0 && 'awaaz-live-dot')}
            />
            {live && <span>{t('map.live')}</span>}
            <span className="font-latin text-slate-500">· {t('map.pinsCount', { n: pins.length })}</span>
          </span>
          <LocateButton state={geo.state} onLocate={() => void onLocate()} className="pointer-events-auto" />
        </div>
      )}

      {(showEmpty || toast) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(max(1.75rem,env(safe-area-inset-bottom)_+_0.75rem)_+_12.75rem)] z-20 flex justify-center px-4">
          <div role="status" aria-live="polite" className="max-w-sm rounded-2xl bg-ink/90 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-lg">
            {toast ?? (allPins.length === 0 ? t('map.emptyHint') : t('map.noMatch'))}
          </div>
        </div>
      )}

      {/* NEARBY_DIGEST_HOOK — phase 2: "what's happening near me" AI digest button (renders nothing yet) */}

      <ActionBar
        onVoice={goVoice}
        onPhoto={goPhoto}
        onText={goText}
        micOverlay={showCoach ? <CoachMark onDismiss={dismissCoach} autoPlay={firstRun} /> : null}
      />

      {/* ---------- sheets ---------- */}
      {(isReport || reportMounted) && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30">
              <Spinner className="size-10 text-white" />
            </div>
          }
        >
          <ReportSheet
            open={isReport}
            mode={reportMode}
            onClose={closeToMap}
            mapCenter={view.center}
            onDone={onReportDone}
          />
        </Suspense>
      )}
      {selectedId && (
        <PinSheet clusterId={selectedId} pin={selectedPin} onClose={closeToMap} userLocation={userPos} />
      )}
    </div>
  )
}
