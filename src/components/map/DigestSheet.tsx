import clsx from 'clsx'
import {
  ChevronRight, Clock, CloudOff, Ear, LocateFixed, MapPinned, Mic, RefreshCw, ShieldCheck, Sparkles, Square, Volume2,
  VolumeX, WifiOff,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { distanceM, type GeoFix } from '../../hooks/useGeolocation'
import { api } from '../../lib/api'
import { CATEGORY_META, URGENCY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import type { Category, DigestResponse, Lang, MapPin } from '../../lib/types'
import { playPrompt, playUrl, stopVoice, useVoicePlaying, buzz } from '../../lib/voice/player'
import { AiLabel, Button, CategoryIcon, Sheet, Spinner, UrgencyBadge, useTimeAgo } from '../ui'
import { DIGEST_RADIUS_M as RADIUS_M, isActivePin as isActive } from './DigestButton'
import { useFormatDistance } from './useFormatDistance'

/**
 * "What's happening near me?" — AI area digest for the citizen map.
 * <DigestButton/> (DigestButton.tsx) floats on the map; this sheet is code-split and loads on tap.
 * <DigestSheet/> finds the user (GPS, else the map centre), calls api.digestNearby, shows the bilingual summary
 * with <AiLabel/>, reads it aloud (server audio_url, else api.tts) and lists what is nearby as icon chips.
 */

/** a GPS fix younger than this is reused instead of asking again */
const FIX_FRESH_MS = 5 * 60_000
/** wait this long for GPS, then fall back to the map centre */
const LOCATE_WAIT_MS = 7000
/** reopening the sheet for the same spot within this window reuses the last digest (no new AI call) */
const MEMO_MS = 3 * 60_000
const AUDIO_KEY = 'digest:nearby'

type LatLng = { lat: number; lng: number }
type Origin = LatLng & { source: 'gps' | 'map' }
type Phase = 'locating' | 'loading' | 'ready' | 'error'

let lastDigest: { key: string; at: number; res: DigestResponse; lang: Lang } | null = null
const originKey = (o: LatLng) => `${o.lat.toFixed(3)},${o.lng.toFixed(3)}`

/** The digest text + the language it is actually in (falls back to the other language when one is empty). */
function voiceOf(res: DigestResponse, lang: Lang): { text: string; lang: Lang } {
  if (lang === 'ur') return res.ur ? { text: res.ur, lang: 'ur' } : { text: res.en, lang: 'en' }
  return res.en ? { text: res.en, lang: 'en' } : { text: res.ur, lang: 'ur' }
}

// ------------------------------------------------------------------------------------------ sheet

export function DigestSheet({
  onClose, pins, userFix, locate, mapCenter, onPickCategory, onOpenPin, onReport,
}: {
  onClose: () => void
  /** every pin loaded on the map (unfiltered): chips + "most important" list are built from these */
  pins: readonly MapPin[]
  userFix: GeoFix | null
  locate: () => Promise<GeoFix | null>
  mapCenter: LatLng
  onPickCategory: (c: Category) => void
  onOpenPin: (id: string) => void
  onReport: () => void
}) {
  const { t, lang, pick } = useI18n()
  const timeAgo = useTimeAgo()
  const fmtDist = useFormatDistance()
  const playingKey = useVoicePlaying()
  const playing = playingKey === AUDIO_KEY

  const [phase, setPhase] = useState<Phase>('locating')
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [data, setData] = useState<{ res: DigestResponse; lang: Lang } | null>(null)
  const [error, setError] = useState<'offline' | 'failed' | null>(null)
  const [voice, setVoice] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const [, setTick] = useState(0)

  const req = useRef(0)
  const clip = useRef<{ text: string; lang: Lang; url: string } | null>(null)
  const skipLocate = useRef<(() => void) | null>(null)
  const latest = useRef({ userFix, locate, mapCenter, lang })
  useEffect(() => { latest.current = { userFix, locate, mapCenter, lang } })

  /** Read the digest aloud in `want` (server clip when it matches, else /tts). */
  const speak = useCallback(async (res: DigestResponse, resLang: Lang, want: Lang, my: number) => {
    const v = voiceOf(res, want)
    if (!v.text) return
    let url = clip.current && clip.current.text === v.text && clip.current.lang === v.lang ? clip.current.url : undefined
    if (!url && res.audio_url && resLang === want) url = res.audio_url
    if (!url) {
      setVoice('loading')
      try {
        url = (await api.tts(v.text, v.lang)).url
      } catch {
        if (my === req.current) setVoice('unavailable')
        return
      }
    }
    if (my !== req.current) return
    clip.current = { text: v.text, lang: v.lang, url }
    setVoice('idle')
    await playUrl(url, AUDIO_KEY)
  }, [])

  const load = useCallback(async (force: boolean) => {
    const my = ++req.current
    stopVoice()
    setError(null)
    setVoice('idle')
    const { userFix: fix, locate: findMe, mapCenter: centre, lang: l } = latest.current

    let o: Origin
    if (fix && Date.now() - fix.at < FIX_FRESH_MS) {
      o = { lat: fix.lat, lng: fix.lng, source: 'gps' }
    } else {
      setPhase('locating')
      const f = await new Promise<GeoFix | null>((resolve) => {
        const timer = window.setTimeout(() => resolve(null), LOCATE_WAIT_MS)
        skipLocate.current = () => { window.clearTimeout(timer); resolve(null) }
        findMe().then((r) => { window.clearTimeout(timer); resolve(r) }, () => { window.clearTimeout(timer); resolve(null) })
      })
      skipLocate.current = null
      if (my !== req.current) return
      o = f ? { lat: f.lat, lng: f.lng, source: 'gps' } : { lat: centre.lat, lng: centre.lng, source: 'map' }
    }
    setOrigin(o)

    const key = originKey(o)
    if (!force && lastDigest && lastDigest.key === key && Date.now() - lastDigest.at < MEMO_MS) {
      setData({ res: lastDigest.res, lang: lastDigest.lang })
      setPhase('ready')
      void speak(lastDigest.res, lastDigest.lang, l, my)
      return
    }

    setPhase('loading')
    try {
      const res = await api.digestNearby(o.lat, o.lng, RADIUS_M, l)
      if (my !== req.current) return
      if (!res || typeof res.en !== 'string') throw new Error('bad digest response')
      lastDigest = { key, at: Date.now(), res, lang: l }
      setData({ res, lang: l })
      setPhase('ready')
      buzz(25)
      void speak(res, l, l, my)
    } catch {
      if (my !== req.current) return
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      setError(offline ? 'offline' : 'failed')
      setPhase('error')
      void playPrompt('tryAgain', l)
    }
  }, [speak])

  // load on open; closing cancels late answers and stops the voice
  useEffect(() => {
    void load(false)
    return () => {
      req.current++
      skipLocate.current?.()
      stopVoice()
    }
  }, [load])

  // keep "updated x min ago" fresh
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // ---- what is nearby, from the pins already on the map ----
  const nearby = useMemo(() => {
    if (!origin) return []
    const out: { p: MapPin; d: number }[] = []
    for (const p of pins) {
      if (!isActive(p)) continue
      const d = distanceM(origin, p)
      if (d <= RADIUS_M) out.push({ p, d })
    }
    return out
  }, [pins, origin])

  const catCounts = useMemo(() => {
    const c = new Map<Category, number>()
    for (const { p } of nearby) c.set(p.category, (c.get(p.category) ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1])
  }, [nearby])

  const top = useMemo(() => [...nearby]
    .sort((a, b) =>
      (URGENCY_META[b.p.urgency]?.rank ?? 0) - (URGENCY_META[a.p.urgency]?.rank ?? 0) ||
      (a.p.status === 'disputed' ? 1 : 0) - (b.p.status === 'disputed' ? 1 : 0) ||
      a.d - b.d)
    .slice(0, 3), [nearby])

  const km = t('common.km', { n: RADIUS_M / 1000 })
  const count = data ? Math.max(data.res.pin_count, nearby.length) : nearby.length
  const quiet = Boolean(data && data.res.pin_count === 0 && nearby.length === 0)
  const busy = phase === 'locating' || phase === 'loading'
  const text = data ? voiceOf(data.res, lang).text : ''

  const onListen = () => {
    if (!data) return
    if (playing) { stopVoice(); return }
    if (voice === 'loading') return
    void speak(data.res, data.lang, lang, req.current)
  }

  const listenLabel = voice === 'loading'
    ? t('map.digestPreparing')
    : playing ? t('map.digestStop') : clip.current ? t('map.digestListenAgain') : t('map.digestListen')

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <span
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-amber-950"
            style={{ background: 'linear-gradient(140deg, #FDE68A, #F59E0B)' }}
          >
            <Ear className="size-6" strokeWidth={2.4} />
          </span>
          <span className="min-w-0 leading-tight">{t('map.digestTitle')}</span>
        </span>
      }
    >
      {/* where + when */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-600">
        <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-slate-100 px-3">
          {origin?.source === 'map'
            ? <MapPinned className="size-4 shrink-0 text-slate-500" />
            : <LocateFixed className="size-4 shrink-0 text-blue-600" />}
          {origin?.source === 'map' ? t('map.digestAroundMap', { km }) : t('map.digestAroundYou', { km })}
        </span>
        {data && phase !== 'loading' && (
          <span className="inline-flex min-h-8 items-center gap-1.5">
            <Clock className="size-4 shrink-0" />
            {t('map.digestUpdated', { t: timeAgo(data.res.generated_at) })}
          </span>
        )}
      </div>
      {origin?.source === 'map' && phase !== 'locating' && (
        <p className="mb-3 text-sm text-slate-500">{t('map.digestMapNote')}</p>
      )}

      {/* ---- finding the user ---- */}
      {phase === 'locating' && (
        <div className="flex flex-col items-center gap-3 py-8 text-center" role="status" aria-live="polite">
          <span className="relative inline-flex size-16 items-center justify-center rounded-full bg-blue-50 text-blue-600">
            <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-blue-200/60" />
            <LocateFixed className="relative size-8" />
          </span>
          <p className="font-semibold text-slate-700">{t('map.locating')}</p>
          <Button variant="secondary" icon={MapPinned} onClick={() => skipLocate.current?.()}>
            {t('map.digestUseMap')}
          </Button>
        </div>
      )}

      {/* ---- error (keeps the last digest if there was one) ---- */}
      {phase === 'error' && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl bg-red-50 p-3 text-red-800 ring-1 ring-red-200">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white">
            {error === 'offline' ? <WifiOff className="size-6" /> : <CloudOff className="size-6" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold">{error === 'offline' ? t('map.digestOffline') : t('map.digestError')}</p>
            {!data && origin && (
              <p className="text-sm text-red-700">
                {nearby.length > 0 ? t('map.digestLocalCount', { n: nearby.length, km }) : t('map.digestLocalNone', { km })}
              </p>
            )}
          </div>
          <Button variant="danger" icon={RefreshCw} onClick={() => void load(true)}>{t('common.retry')}</Button>
        </div>
      )}

      {/* ---- loading skeleton ---- */}
      {phase === 'loading' && !data && (
        <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200" role="status" aria-live="polite" aria-busy="true">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-amber-900">
            <Sparkles className="size-4 animate-pulse" /> {t('map.digestLoading')}
          </div>
          <div className="animate-pulse space-y-3" aria-hidden>
            <div className="h-4 w-full rounded-full bg-amber-200/70" />
            <div className="h-4 w-11/12 rounded-full bg-amber-200/70" />
            <div className="h-4 w-4/5 rounded-full bg-amber-200/70" />
            <div className="h-4 w-3/5 rounded-full bg-amber-200/70" />
          </div>
          <div className="mt-4 h-16 animate-pulse rounded-2xl bg-amber-200/60" aria-hidden />
        </div>
      )}

      {/* ---- the digest ---- */}
      {data && (
        <div className={clsx('transition-opacity', phase === 'loading' && 'opacity-60')} aria-busy={busy}>
          {quiet ? (
            <section
              aria-live="polite"
              className="flex flex-col items-center gap-2 rounded-3xl p-5 text-center"
              style={{ background: STATUS_META.resolved.soft, color: STATUS_META.resolved.color }}
            >
              <span className="inline-flex size-16 items-center justify-center rounded-full text-white" style={{ background: STATUS_META.resolved.color }}>
                <ShieldCheck className="size-9" />
              </span>
              <div className="text-xl font-extrabold">{t('map.digestQuietTitle')}</div>
              <p dir="auto" className="text-base font-medium text-ink">{text}</p>
            </section>
          ) : (
            <section aria-live="polite" className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {data.res.ai
                  ? <AiLabel />
                  : <span className="inline-flex items-center rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">{t('map.digestQuick')}</span>}
                <span className="ms-auto inline-flex items-center rounded-full bg-white px-2.5 py-0.5 text-xs font-bold text-ink ring-1 ring-amber-200">
                  {count === 1 ? t('map.digestCount1') : t('map.digestCount', { n: count })}
                </span>
              </div>
              <p dir="auto" className="text-lg font-medium leading-relaxed text-ink">{text}</p>
            </section>
          )}

          {/* big listen + refresh */}
          <div className="mt-3 flex items-stretch gap-2">
            <button
              type="button"
              onClick={onListen}
              aria-pressed={playing}
              className={clsx(
                'relative inline-flex min-h-16 flex-1 items-center justify-center gap-3 rounded-2xl px-4 text-lg font-extrabold text-amber-950 shadow-md transition active:scale-[0.98]',
                playing ? 'bg-amber-300 ring-2 ring-amber-500' : 'bg-amber-400',
              )}
            >
              <span className="relative inline-flex size-11 items-center justify-center rounded-full bg-white/50">
                {playing && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-white/50" />}
                {voice === 'loading'
                  ? <Spinner className="size-6" />
                  : playing ? <Square className="relative size-5 fill-current" /> : <Volume2 className="relative size-7" />}
              </span>
              {listenLabel}
            </button>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={busy}
              aria-label={t('map.digestRefresh')}
              title={t('map.digestRefresh')}
              className="inline-flex min-h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-ink shadow-sm transition active:scale-95 disabled:opacity-60"
            >
              <RefreshCw className={clsx('size-7', busy && 'animate-spin')} />
            </button>
          </div>
          {voice === 'unavailable' && (
            <p role="status" className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-600">
              <VolumeX className="size-5 shrink-0" /> {t('map.digestNoVoice')}
            </p>
          )}

          {quiet && (
            <Button variant="primary" size="lg" icon={Mic} onClick={onReport} className="mt-3 w-full">
              {t('map.digestReport')}
            </Button>
          )}
        </div>
      )}

      {/* ---- what is nearby (icons for people who do not read) ---- */}
      {phase !== 'locating' && catCounts.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-sm font-bold text-slate-500">{t('map.digestNearbyTypes')}</h3>
          <div className="flex flex-wrap gap-2">
            {catCounts.map(([c, n]) => {
              const m = CATEGORY_META[c] ?? CATEGORY_META.other
              const name = pick(m.en, m.ur)
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onPickCategory(c)}
                  aria-label={`${t('map.digestShowCat', { cat: name })} (${n})`}
                  title={t('map.digestShowCat', { cat: name })}
                  className="inline-flex min-h-12 items-center gap-2 rounded-full py-1 ps-1 pe-3 font-bold text-ink transition active:scale-95"
                  style={{ background: m.soft, boxShadow: `inset 0 0 0 1.5px ${m.color}55` }}
                >
                  <CategoryIcon category={c} size={38} />
                  <span>{name}</span>
                  <span className="font-latin min-w-6 rounded-full bg-white px-1.5 text-center text-sm">{n}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {phase !== 'locating' && top.length > 0 && (
        <section className="mt-5">
          <h3 className="mb-2 text-sm font-bold text-slate-500">{t('map.digestTop')}</h3>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
            {top.map(({ p, d }) => {
              const s = STATUS_META[p.status] ?? STATUS_META.unconfirmed
              const SIcon = s.icon
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onOpenPin(p.id)}
                    className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-start transition hover:bg-slate-50 active:bg-slate-100"
                  >
                    <CategoryIcon category={p.category} size={44} />
                    <span className="min-w-0 flex-1">
                      <span dir="auto" className="block truncate font-bold text-ink">
                        {pick(p.title_en, p.title_ur) || t('map.unknownTitle')}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                        <UrgencyBadge urgency={p.urgency} />
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold" style={{ background: s.soft, color: s.color }}>
                          <SIcon className="size-3.5" /> {pick(s.en, s.ur)}
                        </span>
                        <span className="font-semibold text-slate-500">{t('map.away', { d: fmtDist(d) })}</span>
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="size-5 shrink-0 text-slate-400 rtl:rotate-180" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </Sheet>
  )
}
