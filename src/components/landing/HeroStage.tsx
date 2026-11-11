// Hero stage: glowing globe -> dive into Pakistan -> live Leaflet map of Islamabad with real pins.
// Every heavy piece (cobe, d3-geo + world atlas, Leaflet) is its own lazy chunk; the placeholder sphere keeps the size fixed.
import clsx from 'clsx'
import { ArrowRight, Map as MapIcon } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { detectGlobeMode, type LandingPin } from './shared'

const CobeGlobe = lazy(() => import('./CobeGlobe'))
const SvgGlobe = lazy(() => import('./SvgGlobe'))
const LiveMap = lazy(() => import('./LiveMap'))

type Mode = 'probe' | 'webgl' | 'static'
type Phase = 'globe' | 'reveal' | 'map'

export function HeroStage({ pins, onOpen, openLabel }: { pins: LandingPin[] | null; onOpen: () => void; openLabel: string }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<Mode>('probe')
  const [phase, setPhase] = useState<Phase>('globe')
  const [globeReady, setGlobeReady] = useState(false)
  const [arrived, setArrived] = useState(false)
  const [mapWanted, setMapWanted] = useState(false)
  const [mapReady, setMapReady] = useState(false)

  // capability probe after first paint (creating a WebGL context is not free)
  useEffect(() => {
    const id = window.setTimeout(() => {
      const m = detectGlobeMode()
      setMode(m)
      if (m === 'webgl') setMapWanted(true) // prewarm the map + tiles under the globe
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  // reveal the map once the globe has arrived over Pakistan (webgl) or the user asked for it (static) and tiles are in
  const wantReveal = mode === 'webgl' ? arrived : mapWanted
  useEffect(() => {
    if (phase !== 'globe' || !wantReveal) return
    if (mapReady) { setPhase('reveal'); return }
    const id = window.setTimeout(() => setPhase('reveal'), 3000) // slow tiles: reveal anyway
    return () => window.clearTimeout(id)
  }, [phase, wantReveal, mapReady])
  useEffect(() => {
    if (phase !== 'reveal') return
    const id = window.setTimeout(() => setPhase('map'), 1400)
    return () => window.clearTimeout(id)
  }, [phase])

  const onGlobeReady = useCallback(() => setGlobeReady(true), [])
  const onArrive = useCallback(() => setArrived(true), [])
  const onMapReady = useCallback(() => setMapReady(true), [])

  const showMap = phase !== 'globe'
  const count = pins?.length ?? 0
  const cityLabel = t('landing.cityIsb')

  return (
    // GLOBE_HOOK — the animated globe lives here (lazy chunks: CobeGlobe / SvgGlobe / LiveMap)
    <div id="globe-hero" className="lp-stage" role="region" aria-label={t('landing.stageMapLabel')}>
      <div aria-hidden className="lp-halo" />
      <div aria-hidden className="lp-sphere" style={{ opacity: globeReady || showMap ? 0 : 1 }} />

      {/* globe */}
      {phase !== 'map' && mode !== 'probe' && (
        <div aria-hidden className={clsx('lp-globe', showMap && 'is-out')}>
          <Suspense fallback={null}>
            {mode === 'webgl'
              ? <CobeGlobe onReady={onGlobeReady} onArrive={onArrive} label={cityLabel} />
              : <SvgGlobe onReady={onGlobeReady} label={cityLabel} />}
          </Suspense>
        </div>
      )}

      {/* tap the globe to skip the intro */}
      {mode === 'webgl' && phase === 'globe' && (
        <button type="button" onClick={onArrive} aria-label={t('landing.stageOpen')}
          className="absolute inset-[12%] z-10 cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300" />
      )}

      {/* live map */}
      {mapWanted && (
        <div className={clsx('lp-map', showMap && 'is-on', phase === 'map' && 'is-done')}>
          <Suspense fallback={null}>
            <LiveMap pins={pins} play={showMap} onReady={onMapReady} />
          </Suspense>
          <div aria-hidden className="lp-map-vignette" />
        </div>
      )}

      {/* overlays */}
      {showMap ? (
        <>
          <div className="lp-fade-in pointer-events-none absolute inset-x-3 top-3 z-10 flex justify-start" style={{ animationDelay: '.5s' }}>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#030916]/75 px-3 py-1.5 text-xs font-bold text-white shadow-lg ring-1 ring-white/15 backdrop-blur-sm">
              <span className="lp-live-dot" />
              <span className="font-latin uppercase tracking-wider text-red-300">{t('landing.stageLive')}</span>
              <span className="text-white/85">{count > 0 ? t('landing.stagePins', { n: count }) : t('landing.stagePinsNone')}</span>
            </span>
          </div>
          <div className="lp-fade-in absolute inset-x-3 bottom-7 z-10 flex justify-center" style={{ animationDelay: '.9s' }}>
            <button type="button" onClick={onOpen}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-bold text-[#06213a] shadow-xl shadow-black/30 transition hover:bg-white active:scale-95">
              <MapIcon className="size-4 text-brand-700" />
              {openLabel}
              <ArrowRight className="size-4 rtl:-scale-x-100" />
            </button>
          </div>
        </>
      ) : mode === 'static' ? (
        <div className="absolute inset-x-3 bottom-1 z-10 flex justify-center">
          <button type="button" onClick={() => setMapWanted(true)} disabled={mapWanted}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/95 px-4 text-sm font-bold text-[#06213a] shadow-xl shadow-black/30 transition hover:bg-white active:scale-95 disabled:opacity-80">
            <MapIcon className="size-4 text-brand-700" />
            {mapWanted ? t('landing.stageLoading') : t('landing.stageOpen')}
          </button>
        </div>
      ) : (
        <div className={clsx('pointer-events-none absolute inset-x-0 -bottom-1 z-10 flex justify-center transition-opacity duration-700', arrived ? 'opacity-100' : 'opacity-0')}>
          <span className="rounded-full bg-[#030916]/70 px-3 py-1 text-xs font-semibold text-teal-100 ring-1 ring-teal-300/25">
            {t('landing.stageGlobe')}
          </span>
        </div>
      )}
    </div>
  )
}
