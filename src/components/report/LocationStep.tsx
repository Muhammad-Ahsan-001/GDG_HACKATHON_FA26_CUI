import { ArrowLeft, Check, Loader2, LocateFixed, MapPinOff, Search } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { GeoFix } from '../../hooks/useGeolocation'
import { searchPlace } from '../../lib/geocode'
import { useI18n } from '../../lib/i18n'
import type { LatLng } from '../leaflet/BaseMap'
import { LocationPicker } from '../leaflet/LocationPicker'
import { VoiceGuide } from '../voice/VoiceGuide'

export interface PickedLoc { lat: number; lng: number; source: 'gps' | 'map' | 'geocoded'; label?: string; accuracy?: number }

/** Choose the exact spot: tap / drag on the map, search a place (Nominatim, on submit only) or use GPS. */
export function LocationStep({ initial, userLocation, hints, problem, onUse, onBack, onLocate }: {
  initial: PickedLoc
  userLocation: LatLng | null
  /** places the AI heard (tap to search them) */
  hints?: string[]
  /** shown as "we could not find where this is" (needs_location) instead of the plain chooser */
  problem?: boolean
  onUse: (p: PickedLoc) => void
  onBack: () => void
  onLocate: () => Promise<GeoFix | null>
}) {
  const { t, lang } = useI18n()
  const [point, setPoint] = useState<PickedLoc>(initial)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [locating, setLocating] = useState(false)

  const onMapChange = useCallback((p: LatLng) => {
    setPoint({ lat: p.lat, lng: p.lng, source: 'map' })
    setNotFound(false)
  }, [])

  const search = async (q: string) => {
    const v = q.trim()
    if (!v || searching) return
    setQuery(v)
    setSearching(true)
    setNotFound(false)
    const hit = await searchPlace(v, lang)
    setSearching(false)
    if (hit) setPoint({ lat: hit.lat, lng: hit.lng, source: 'geocoded', label: v })
    else setNotFound(true)
  }

  const locateMe = async () => {
    setLocating(true)
    const f = await onLocate()
    setLocating(false)
    if (f) setPoint({ lat: f.lat, lng: f.lng, source: 'gps', accuracy: f.accuracy })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('common.back')}
          title={t('common.back')}
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-slate-100 text-ink active:scale-95"
        >
          <ArrowLeft className="size-6 rtl:-scale-x-100" />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-lg font-bold">
            {problem && <MapPinOff className="size-5 shrink-0 text-amber-600" />}
            {problem ? t('report.needsLocTitle') : t('report.whereTitle')}
          </h3>
          <p className="text-sm text-slate-600">{t('report.whereBody')}</p>
        </div>
        <VoiceGuide prompt="needLocation" label={false} size={44} />
      </div>

      {hints && hints.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-slate-500">{t('report.weUnderstood')}</span>
          {hints.map((h) => (
            <button key={h} type="button" onClick={() => { void search(h) }} dir="auto"
              className="inline-flex min-h-10 items-center gap-1 rounded-full bg-slate-100 px-3 font-medium text-slate-700 active:scale-95">
              <Search className="size-3.5" /> {h}
            </button>
          ))}
        </div>
      )}

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(query) }}>
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('report.addressLabel')}</span>
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            dir="auto"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setNotFound(false) }}
            placeholder={t('report.searchPlaceholder')}
            maxLength={160}
            enterKeyHint="search"
            autoComplete="off"
            className="min-h-14 w-full rounded-2xl border-2 border-slate-200 bg-white pe-3 ps-11 text-base outline-none focus:border-brand-600"
          />
        </label>
        <button
          type="submit"
          disabled={searching || query.trim().length < 2}
          className="inline-flex min-h-14 shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-brand-700 px-4 font-bold text-white shadow-sm hover:bg-brand-600 active:scale-[0.98] disabled:bg-slate-300 disabled:shadow-none"
        >
          {searching ? <Loader2 className="size-5 animate-spin" /> : <Search className="size-5" />}
          <span className="hidden min-[400px]:inline">{t('report.search')}</span>
        </button>
      </form>
      {notFound && <p role="alert" className="-mt-1 text-sm font-semibold text-amber-700">{t('report.placeNotFound')}</p>}

      <div className="relative">
        <LocationPicker value={point} onChange={onMapChange} userLocation={userLocation} height={300} zoom={16} />
        <button
          type="button"
          onClick={() => { void locateMe() }}
          className="absolute bottom-3 end-3 z-[500] inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-4 text-sm font-bold text-ink shadow-lg ring-1 ring-slate-200 active:scale-95"
        >
          {locating ? <Loader2 className="size-5 animate-spin" /> : <LocateFixed className="size-5 text-blue-600" />}
          {t('report.useMyLocation')}
        </button>
      </div>
      <p className="text-center text-sm text-slate-500">{t('report.tapOrDrag')}</p>

      <button
        type="button"
        onClick={() => onUse(point)}
        className="inline-flex min-h-16 shrink-0 items-center justify-center gap-3 rounded-2xl bg-brand-700 px-6 text-xl font-bold text-white shadow-lg active:scale-[0.98]"
      >
        <Check className="size-7" strokeWidth={3} /> {problem ? t('report.useSpotSend') : t('report.useSpot')}
      </button>
    </div>
  )
}
