// Responder dashboard map — Leaflet + OpenStreetMap (shared BaseMap layer; no API key needed).
import L from 'leaflet'
import { Building2, Siren } from 'lucide'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { Circle, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import { config } from '../../config'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { BaseMap, InvalidateOnResize } from '../leaflet/BaseMap'
import { pinIcon, svg } from '../leaflet/icons'
import { SOS_RED } from './SosCard'
import type { DashAssignment, MapFocus } from './types'
import { isSos, type SosLive } from './useSosLive'

export interface ServiceArea {
  id: string
  name: string
  lat: number
  lng: number
  radius_m: number | null
}

export interface DashboardMapProps {
  /** the assignments currently listed (one marker per cluster) */
  items: DashAssignment[]
  selectedId: string | null
  highlightIds: ReadonlySet<string>
  /** org service areas to outline (centre + radius) */
  areas: ServiceArea[]
  /** pan here whenever a new object is passed */
  focus: MapFocus | null
  /** the camera fits areas + items once per distinct key (e.g. per org filter) once `ready` */
  fitKey: string
  ready: boolean
  onSelect: (assignmentId: string) => void
  onBackgroundClick?: () => void
  /** live SOS sessions (session id -> state): SOS markers sit at the live location and move with it */
  sosLive?: ReadonlyMap<string, SosLive>
  /** keep the camera on this point (SOS "follow"); a manual drag calls onFollowCancel */
  follow?: MapFocus | null
  onFollowCancel?: () => void
}

const BRAND = '#0f766e'
const BRAND_FILL = '#14b8a6'

type IconNode = Parameters<typeof svg>[0]
const hqIcon = L.divIcon({
  html: `<div style="width:32px;height:32px;border-radius:8px;border:2px solid #fff;background:${BRAND};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.35)">${svg(Building2 as unknown as IconNode, 16, '#fff')}</div>`,
  className: 'awz-pin-wrap',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
})

/** SOS marker: red siren badge with two expanding rings and an "SOS" tag. Styles: dashboard.css (.awz-sos-*). */
const sosIconCache = new Map<string, L.DivIcon>()
function sosIcon(selected: boolean, quiet: boolean): L.DivIcon {
  const key = `${selected ? 1 : 0}${quiet ? 1 : 0}`
  const hit = sosIconCache.get(key)
  if (hit) return hit
  const s = selected ? 64 : 54
  const icon = L.divIcon({
    html: `<div class="awz-sos-pin${quiet ? ' awz-sos-quiet' : ''}" style="--sos:${SOS_RED};--s:${s}px">`
      + '<span class="awz-sos-ring"></span><span class="awz-sos-ring awz-sos-ring-2"></span>'
      + `<span class="awz-sos-body">${svg(Siren as unknown as IconNode, Math.round(s * 0.48), '#fff', 2.4)}</span>`
      + '<span class="awz-sos-tag">SOS</span></div>',
    className: 'awz-pin-wrap',
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  })
  sosIconCache.set(key, icon)
  return icon
}

/** Responder map: category-coloured markers, service-area circle, pan-to-selection. */
export function DashboardMap({
  items, selectedId, highlightIds, areas, focus, fitKey, ready, onSelect, onBackgroundClick, sosLive, follow, onFollowCancel,
}: DashboardMapProps) {
  const { t, pick, lang } = useI18n()
  // uncontrolled camera: only the initial centre matters
  const initialCenter = useMemo(
    () => (areas[0] ? { lat: areas[0].lat, lng: areas[0].lng } : config.defaultCenter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const selectedCluster = useMemo(
    () => items.find((i) => i.assignment_id === selectedId)?.cluster_id ?? null,
    [items, selectedId],
  )

  // One marker per cluster (several orgs can be alerted for the same incident in the admin view).
  const markers = useMemo(() => {
    const byCluster = new Map<string, { a: DashAssignment; highlighted: boolean }>()
    for (const a of items) {
      const prev = byCluster.get(a.cluster_id)
      const hl = highlightIds.has(a.assignment_id)
      if (!prev) byCluster.set(a.cluster_id, { a, highlighted: hl })
      else if (hl) prev.highlighted = true
    }
    return [...byCluster.values()]
  }, [items, highlightIds])

  const handleClick = useCallback(() => onBackgroundClick?.(), [onBackgroundClick])

  return (
    <BaseMap center={initialCenter} zoom={config.defaultZoom} className="h-full w-full" zoomControl onClick={handleClick}>
      <InvalidateOnResize />
      {areas.map((ar) => (
        <ServiceAreaOverlay key={ar.id} area={ar} label={t('dashboard.serviceAreaOf', { name: ar.name })} />
      ))}
      {markers.map(({ a, highlighted }) => {
        const cat = CATEGORY_META[a.category] ?? CATEGORY_META.other
        const title = pick(a.title_en, a.title_ur) || (lang === 'ur' ? cat.ur : cat.en)
        if (isSos(a)) {
          return (
            <SosMarker
              key={a.cluster_id}
              a={a}
              live={a.sos_session_id ? sosLive?.get(a.sos_session_id) : undefined}
              label={`${t('dashboard.sosLabel')} - ${title}`}
              selected={a.cluster_id === selectedCluster}
              onSelect={onSelect}
            />
          )
        }
        return (
          <IncidentMarker
            key={a.cluster_id}
            a={a}
            label={title}
            selected={a.cluster_id === selectedCluster}
            highlighted={highlighted}
            onSelect={onSelect}
          />
        )
      })}
      <CameraController
        focus={focus}
        fitKey={fitKey}
        ready={ready}
        areas={areas}
        items={items}
        follow={follow ?? null}
        onFollowCancel={onFollowCancel}
      />
    </BaseMap>
  )
}

interface IncidentMarkerProps {
  a: DashAssignment
  label: string
  selected: boolean
  highlighted: boolean
  onSelect: (assignmentId: string) => void
}

const IncidentMarker = memo(function IncidentMarker({ a, label, selected, highlighted, onSelect }: IncidentMarkerProps) {
  const icon = pinIcon({
    category: a.category,
    status: a.cluster_status,
    urgency: a.urgency,
    count: a.report_count,
    selected,
    pulse: highlighted,
    flash: highlighted,
  })
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const id = a.assignment_id
  const handlers = useMemo(() => ({ click: () => onSelectRef.current(id) }), [id])
  const resolved = a.status === 'resolved'
  return (
    <Marker
      position={[a.lat, a.lng]}
      icon={icon}
      title={label}
      alt={label}
      zIndexOffset={selected ? 10_000 : resolved ? 0 : 1000}
      eventHandlers={handlers}
    />
  )
})

interface SosMarkerProps {
  a: DashAssignment
  live: SosLive | undefined
  label: string
  selected: boolean
  onSelect: (assignmentId: string) => void
}

/** SOS: marker at the live location (moves with every update) + GPS accuracy circle + the trail seen so far. */
const SosMarker = memo(function SosMarker({ a, live, label, selected, onSelect }: SosMarkerProps) {
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const id = a.assignment_id
  const handlers = useMemo(() => ({ click: () => onSelectRef.current(id) }), [id])
  const lat = live?.lat ?? a.lat
  const lng = live?.lng ?? a.lng
  const ended = a.status === 'resolved' || live?.status === 'safe' || live?.status === 'cancelled'
  const acc = live?.last_accuracy_m ?? null
  const trail = live?.trail ?? []
  return (
    <>
      {trail.length > 1 && (
        <Polyline
          positions={trail}
          interactive={false}
          pathOptions={{ color: SOS_RED, weight: 3, opacity: 0.7, dashArray: '6 6' }}
        />
      )}
      {acc != null && acc > 0 && acc <= 1500 && (
        <Circle
          center={[lat, lng]}
          radius={acc}
          interactive={false}
          pathOptions={{ color: SOS_RED, weight: 1, opacity: 0.6, fillColor: SOS_RED, fillOpacity: 0.1 }}
        />
      )}
      <Marker
        position={[lat, lng]}
        icon={sosIcon(selected, ended)}
        title={label}
        alt={label}
        zIndexOffset={ended ? 5000 : 50_000}
        eventHandlers={handlers}
      />
    </>
  )
})

/** Service-area circle + a small HQ marker at the centre. */
function ServiceAreaOverlay({ area, label }: { area: ServiceArea; label: string }) {
  return (
    <>
      {area.radius_m ? (
        <Circle
          center={[area.lat, area.lng]}
          radius={area.radius_m}
          interactive={false}
          pathOptions={{ color: BRAND, opacity: 0.85, weight: 2, fillColor: BRAND_FILL, fillOpacity: 0.07 }}
        />
      ) : null}
      <Marker position={[area.lat, area.lng]} icon={hqIcon} title={label} alt={label} zIndexOffset={-1000}>
        <Tooltip direction="top" offset={[0, -14]}>{label}</Tooltip>
      </Marker>
    </>
  )
}

function CameraController({
  focus, fitKey, ready, areas, items, follow, onFollowCancel,
}: {
  focus: MapFocus | null; fitKey: string; ready: boolean; areas: ServiceArea[]; items: DashAssignment[]
  follow: MapFocus | null; onFollowCancel?: () => void
}) {
  const map = useMap()
  const fittedRef = useRef<string | null>(null)

  // follow mode: keep the moving SOS marker in view (zoom in once, then just pan)
  const followLat = follow?.lat
  const followLng = follow?.lng
  const following = followLat !== undefined && followLng !== undefined
  useEffect(() => {
    if (followLat === undefined || followLng === undefined) return
    if (map.getZoom() < 15) map.flyTo([followLat, followLng], 16, { duration: 0.6 })
    else map.panTo([followLat, followLng], { animate: true, duration: 0.5 })
  }, [map, followLat, followLng])

  // dragging the map by hand ends follow mode
  const cancelRef = useRef(onFollowCancel)
  cancelRef.current = onFollowCancel
  useEffect(() => {
    if (!following) return
    const onDrag = () => cancelRef.current?.()
    map.on('dragstart', onDrag)
    return () => { map.off('dragstart', onDrag) }
  }, [map, following])

  useEffect(() => {
    if (!ready || fittedRef.current === fitKey) return
    fittedRef.current = fitKey
    const pts: L.LatLngExpression[] = []
    for (const ar of areas) {
      if (ar.radius_m) {
        const dLat = ar.radius_m / 111_320
        const dLng = ar.radius_m / (111_320 * Math.max(0.2, Math.cos((ar.lat * Math.PI) / 180)))
        pts.push([ar.lat + dLat, ar.lng + dLng], [ar.lat - dLat, ar.lng - dLng])
      } else {
        pts.push([ar.lat, ar.lng])
      }
    }
    for (const it of items) pts.push([it.lat, it.lng])
    if (pts.length === 0) return
    if (pts.length === 1) { map.setView(pts[0], 14); return }
    map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 16 })
  }, [map, ready, fitKey, areas, items])

  useEffect(() => {
    if (!focus) return
    map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), 15), { duration: 0.6 })
  }, [map, focus])

  return null
}
