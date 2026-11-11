// Shared Leaflet + OpenStreetMap base map. Everything map-related uses this (citizen map, dashboard, pickers).
import L from 'leaflet'
// must come after 'leaflet': the plugin's UMD build extends the global `L` that leaflet sets on window
import 'leaflet.markercluster'
import { useEffect, useRef, type ReactNode } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { config } from '../../config'
import './leaflet.css'

export interface LatLng { lat: number; lng: number }

export function BaseMap({
  center = config.defaultCenter, zoom = config.defaultZoom, className, children, onMoveEnd, onClick, zoomControl = false,
}: {
  center?: LatLng
  zoom?: number
  className?: string
  children?: ReactNode
  /** fires after pan/zoom with the new centre + zoom */
  onMoveEnd?: (center: LatLng, zoom: number, bounds: L.LatLngBounds) => void
  onClick?: (p: LatLng) => void
  zoomControl?: boolean
}) {
  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={zoom}
      zoomControl={zoomControl}
      attributionControl
      className={className ?? 'h-full w-full'}
      // cheap-phone friendly: no fade/zoom animations on low-end, keep tiles light
      fadeAnimation={false}
      markerZoomAnimation
      worldCopyJump={false}
      minZoom={4}
      maxZoom={19}
    >
      <TileLayer url={config.tiles.url} attribution={config.tiles.attribution} maxZoom={19} detectRetina={false} />
      <MapEvents onMoveEnd={onMoveEnd} onClick={onClick} />
      {children}
    </MapContainer>
  )
}

function MapEvents({ onMoveEnd, onClick }: {
  onMoveEnd?: (c: LatLng, z: number, b: L.LatLngBounds) => void
  onClick?: (p: LatLng) => void
}) {
  const map = useMapEvents({
    moveend() {
      const c = map.getCenter()
      onMoveEnd?.({ lat: c.lat, lng: c.lng }, map.getZoom(), map.getBounds())
    },
    click(e) { onClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }) },
  })
  // report the initial view once
  useEffect(() => {
    const c = map.getCenter()
    onMoveEnd?.({ lat: c.lat, lng: c.lng }, map.getZoom(), map.getBounds())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])
  return null
}

/** Imperatively fly/pan the map when `to` changes (e.g. selecting a pin or "locate me"). */
export function FlyTo({ to, zoom }: { to: LatLng | null | undefined; zoom?: number }) {
  const map = useMap()
  const last = useRef<string>('')
  useEffect(() => {
    if (!to) return
    const key = `${to.lat.toFixed(5)},${to.lng.toFixed(5)},${zoom ?? ''}`
    if (key === last.current) return
    last.current = key
    map.flyTo([to.lat, to.lng], zoom ?? Math.max(map.getZoom(), 15), { duration: 0.6 })
  }, [to, zoom, map])
  return null
}

/** Fix grey tiles when the map container is resized/shown after mount (sheets, tabs). */
export function InvalidateOnResize() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

export interface ClusterItem {
  id: string
  lat: number
  lng: number
  icon: L.DivIcon
  /** used to colour the cluster bubble red when it contains urgent pins */
  hot?: boolean
  zIndexOffset?: number
}

/**
 * Marker clustering layer (leaflet.markercluster). Diffs markers by id, so realtime updates
 * only touch changed pins. Clusters disable at zoom >= disableAt.
 */
export function ClusterLayer({ items, onSelect, disableAt = 15 }: {
  items: ClusterItem[]
  onSelect?: (id: string) => void
  disableAt?: number
}) {
  const map = useMap()
  const groupRef = useRef<L.MarkerClusterGroup | null>(null)
  const markers = useRef(new Map<string, L.Marker>())
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    const group = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: disableAt,
      maxClusterRadius: 50,
      chunkedLoading: true,
      iconCreateFunction(cluster) {
        const n = cluster.getChildCount()
        const hot = cluster.getAllChildMarkers().some((m) => (m.options as { hot?: boolean }).hot)
        const s = n < 10 ? 38 : n < 50 ? 46 : 54
        return L.divIcon({ html: `<div>${n}</div>`, className: `awz-cluster${hot ? ' awz-hot' : ''}`, iconSize: [s, s] })
      },
    })
    groupRef.current = group
    map.addLayer(group)
    const current = markers.current
    return () => { map.removeLayer(group); current.clear(); groupRef.current = null }
  }, [map, disableAt])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const seen = new Set<string>()
    const toAdd: L.Marker[] = []
    for (const it of items) {
      seen.add(it.id)
      const existing = markers.current.get(it.id)
      if (existing) {
        const ll = existing.getLatLng()
        if (ll.lat !== it.lat || ll.lng !== it.lng) existing.setLatLng([it.lat, it.lng])
        if (existing.options.icon !== it.icon) existing.setIcon(it.icon)
        ;(existing.options as { hot?: boolean }).hot = it.hot
        existing.setZIndexOffset(it.zIndexOffset ?? 0)
      } else {
        const m = L.marker([it.lat, it.lng], { icon: it.icon, keyboard: true, zIndexOffset: it.zIndexOffset ?? 0 })
        ;(m.options as { hot?: boolean }).hot = it.hot
        m.on('click', () => onSelectRef.current?.(it.id))
        markers.current.set(it.id, m)
        toAdd.push(m)
      }
    }
    const toRemove: L.Marker[] = []
    for (const [id, m] of markers.current) if (!seen.has(id)) { toRemove.push(m); markers.current.delete(id) }
    if (toRemove.length) group.removeLayers(toRemove)
    if (toAdd.length) group.addLayers(toAdd)
    group.refreshClusters()
  }, [items])

  return null
}
