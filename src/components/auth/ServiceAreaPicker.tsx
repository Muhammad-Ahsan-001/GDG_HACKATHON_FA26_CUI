// Service-area picker for organisation registration: GPS button + tap-on-map / drag-the-pin (Leaflet + OSM, shared
// BaseMap) with a live radius circle and a 1–30 km slider.
import L from 'leaflet'
import { LocateFixed, MapPin, Ruler } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Circle, Marker, useMap } from 'react-leaflet'
import { useGeolocation } from '../../hooks/useGeolocation'
import { useI18n } from '../../lib/i18n'
import { BaseMap, InvalidateOnResize, type LatLng } from '../leaflet/BaseMap'
import { pickIcon } from '../leaflet/icons'
import { Button } from '../ui'
import { ErrorBanner } from './parts'

export type { LatLng }

/** Fits the map to the service circle whenever `fitKey` changes (GPS fix, slider released). */
function FitCircle({ center, radiusM, fitKey }: { center: LatLng | null; radiusM: number; fitKey: number }) {
  const map = useMap()
  useEffect(() => {
    if (!center || fitKey === 0) return
    map.flyToBounds(L.latLng(center.lat, center.lng).toBounds(radiusM * 2), { padding: [16, 16], duration: 0.5 })
    // refit only on fitKey changes, not on every tap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])
  return null
}

export function ServiceAreaPicker({ center, onCenter, radiusKm, onRadiusKm }: {
  center: LatLng | null; onCenter: (c: LatLng) => void; radiusKm: number; onRadiusKm: (km: number) => void
}) {
  const { t } = useI18n()
  const { locate, state } = useGeolocation()
  const [fitKey, setFitKey] = useState(0)
  const [askedGps, setAskedGps] = useState(false)
  const radiusM = radiusKm * 1000
  const gpsError = askedGps && state === 'denied' ? 'auth.gpsDenied' : askedGps && state === 'unavailable' ? 'auth.gpsUnavailable' : null

  async function locateMe() {
    setAskedGps(true)
    const fix = await locate()
    if (!fix) return
    onCenter({ lat: fix.lat, lng: fix.lng })
    setFitKey((k) => k + 1)
  }

  const markerHandlers = useMemo<L.LeafletEventHandlerFnMap>(() => ({
    dragend(e) {
      const ll = (e.target as L.Marker).getLatLng()
      onCenter({ lat: ll.lat, lng: ll.lng })
    },
  }), [onCenter])

  return (
    <div className="space-y-3">
      <Button type="button" variant="secondary" size="lg" icon={LocateFixed} loading={state === 'locating'} onClick={locateMe} className="w-full">
        {state === 'locating' ? t('auth.locating') : t('auth.useMyLocation')}
      </Button>
      <ErrorBanner error={gpsError} onDismiss={() => setAskedGps(false)} />

      <p className="text-sm text-slate-600">{t('auth.tapMapHint')}</p>
      <div className="relative isolate z-0 h-64 overflow-hidden rounded-2xl border border-slate-200">
        <BaseMap center={center ?? undefined} zoom={11} zoomControl onClick={onCenter} className="h-full w-full">
          <InvalidateOnResize />
          {center && (
            <>
              <Circle center={[center.lat, center.lng]} radius={radiusM} interactive={false}
                pathOptions={{ color: '#0f766e', weight: 2, opacity: 0.9, fillColor: '#14b8a6', fillOpacity: 0.15 }} />
              <Marker position={[center.lat, center.lng]} icon={pickIcon} draggable eventHandlers={markerHandlers} />
            </>
          )}
          <FitCircle center={center} radiusM={radiusM} fitKey={fitKey} />
        </BaseMap>
      </div>

      <div className="flex items-center gap-2 text-sm text-slate-700">
        <MapPin className="size-4 shrink-0 text-brand-700" />
        {center
          ? <span>{t('auth.centreAt', { lat: center.lat.toFixed(4), lng: center.lng.toFixed(4) })}</span>
          : <span className="text-slate-500">{t('auth.noCentre')}</span>}
      </div>

      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 font-semibold">
          <Ruler className="size-4 text-brand-700" /> {t('auth.radius', { n: radiusKm })}
        </span>
        <input
          type="range" min={1} max={30} step={1} value={radiusKm}
          onChange={(e) => onRadiusKm(Number(e.target.value))}
          onPointerUp={() => setFitKey((k) => k + 1)}
          onKeyUp={() => setFitKey((k) => k + 1)}
          className="h-12 w-full cursor-pointer accent-brand-700"
          aria-label={t('auth.radius', { n: radiusKm })}
        />
        <span className="font-latin flex justify-between text-xs text-slate-500" dir="ltr"><span>1 km</span><span>30 km</span></span>
      </label>
    </div>
  )
}
