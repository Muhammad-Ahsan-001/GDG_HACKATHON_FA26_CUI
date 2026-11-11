import { useCallback, useEffect, useRef, useState } from 'react'

export interface GeoFix { lat: number; lng: number; accuracy: number; at: number }
export type GeoState = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable'

/** One-shot + optional watch geolocation. Cheap-phone friendly: low accuracy first, then high. */
export function useGeolocation(opts: { watch?: boolean } = {}) {
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [state, setState] = useState<GeoState>('idle')
  const watchId = useRef<number | null>(null)

  const onPos = useCallback((p: GeolocationPosition) => {
    setFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp })
    setState('ok')
  }, [])
  const onErr = useCallback((e: GeolocationPositionError) => {
    setState(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable')
  }, [])

  const locate = useCallback((): Promise<GeoFix | null> => {
    if (!('geolocation' in navigator)) { setState('unavailable'); return Promise.resolve(null) }
    setState('locating')
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => { onPos(p); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp }) },
        (e) => { onErr(e); resolve(null) },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      )
    })
  }, [onPos, onErr])

  useEffect(() => {
    if (!opts.watch || !('geolocation' in navigator)) return
    watchId.current = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: false, maximumAge: 120000 })
    return () => { if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current) }
  }, [opts.watch, onPos, onErr])

  return { fix, state, locate }
}

/** Haversine distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
