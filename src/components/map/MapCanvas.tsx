import type L from 'leaflet'
import { memo, useEffect, useMemo } from 'react'
import { Marker, useMap } from 'react-leaflet'
import type { GeoFix } from '../../hooks/useGeolocation'
import { URGENCY_META } from '../../lib/categories'
import type { MapPin } from '../../lib/types'
import { BaseMap, ClusterLayer, InvalidateOnResize, type ClusterItem } from '../leaflet/BaseMap'
import { pinIcon, userDotIcon } from '../leaflet/icons'

/**
 * The citizen map's Leaflet canvas (OSM tiles, clustered pins, the blue "you are here" dot).
 * Code-split from MapPage (loaded via loadMapCanvas.ts) so Leaflet + markercluster (~190 kB) never block the
 * page shell: SOS, the report mic and the chips are usable while the map is still downloading on a cheap phone.
 */
export interface MapCanvasProps {
  /** the pins to draw (already capped + incl. the selected one) */
  pins: readonly MapPin[]
  selectedId: string | null
  highlighted: ReadonlySet<string>
  /** cheap phone: no pin pulse */
  lowEnd: boolean
  fix: GeoFix | null
  youAreHere: string
  onSelect: (id: string) => void
  onMoveEnd: (c: { lat: number; lng: number }) => void
  onMap: (m: L.Map | null) => void
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

function MapCanvas({ pins, selectedId, highlighted, lowEnd, fix, youAreHere, onSelect, onMoveEnd, onMap }: MapCanvasProps) {
  const markerItems = useMemo<ClusterItem[]>(() => pins.map((p) => {
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
        pulse: !lowEnd && rank >= 2 && (p.status === 'unconfirmed' || p.status === 'verified'),
        flash: highlighted.has(p.id),
      }),
      hot: active && rank >= 2,
      zIndexOffset: selected ? 100000 : (active ? 2000 : 0) + rank * 100,
    }
  }), [pins, selectedId, highlighted, lowEnd])

  return (
    <BaseMap className="absolute inset-0 z-0" onMoveEnd={onMoveEnd}>
      <InvalidateOnResize />
      <MapBridge onMap={onMap} />
      <ClusterLayer items={markerItems} onSelect={onSelect} />
      {fix && (
        <Marker
          position={[fix.lat, fix.lng]}
          icon={userDotIcon}
          interactive={false}
          keyboard={false}
          zIndexOffset={200000}
          title={youAreHere}
        />
      )}
    </BaseMap>
  )
}

export default memo(MapCanvas)
