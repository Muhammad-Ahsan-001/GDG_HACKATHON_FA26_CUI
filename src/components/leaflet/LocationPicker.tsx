// Small map for picking a point: tap the map or drag the pin. Optional radius circle (org service area).
import { Circle, Marker } from 'react-leaflet'
import { useMemo } from 'react'
import { BaseMap, FlyTo, InvalidateOnResize, type LatLng } from './BaseMap'
import { pickIcon, userDotIcon } from './icons'

export function LocationPicker({
  value, onChange, radiusM, userLocation, height = 260, zoom = 15, className,
}: {
  value: LatLng
  onChange: (p: LatLng) => void
  /** draw a service-area circle of this radius around the point */
  radiusM?: number
  userLocation?: LatLng | null
  height?: number
  zoom?: number
  className?: string
}) {
  const handlers = useMemo(() => ({
    dragend(e: { target: { getLatLng: () => { lat: number; lng: number } } }) {
      const ll = e.target.getLatLng()
      onChange({ lat: ll.lat, lng: ll.lng })
    },
  }), [onChange])
  return (
    <div className={className ?? 'overflow-hidden rounded-2xl ring-1 ring-slate-200'} style={{ height }}>
      <BaseMap center={value} zoom={zoom} onClick={onChange} zoomControl>
        <InvalidateOnResize />
        <FlyTo to={value} zoom={zoom} />
        {userLocation && <Marker position={[userLocation.lat, userLocation.lng]} icon={userDotIcon} interactive={false} />}
        {radiusM ? <Circle center={[value.lat, value.lng]} radius={radiusM} pathOptions={{ color: '#0f766e', weight: 2, fillOpacity: 0.12 }} /> : null}
        <Marker position={[value.lat, value.lng]} icon={pickIcon} draggable eventHandlers={handlers} />
      </BaseMap>
    </div>
  )
}
