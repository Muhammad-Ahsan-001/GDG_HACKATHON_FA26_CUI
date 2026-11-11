// Service-area map for the organisations panel (lazy: Leaflet). Every org = centre dot + radius circle; selected one is emphasised.
import { Fragment, useEffect } from 'react'
import { Circle, Marker, useMap } from 'react-leaflet'
import type { AdminOrg } from '../../lib/adminApi'
import { CATEGORY_META } from '../../lib/categories'
import { BaseMap, InvalidateOnResize } from '../leaflet/BaseMap'
import { dotIcon } from '../leaflet/icons'
import { ORG_TYPE_META } from '../auth/meta'

function FitSelected({ org }: { org: AdminOrg | null }) {
  const map = useMap()
  useEffect(() => {
    if (!org || !Number.isFinite(org.lat)) return
    const r = org.radius_m ?? 3000
    // fit the service circle
    const lat = (r / 111_320)
    const lng = r / (111_320 * Math.cos((org.lat * Math.PI) / 180))
    map.flyToBounds([[org.lat - lat, org.lng - lng], [org.lat + lat, org.lng + lng]], { padding: [24, 24], duration: 0.6 })
  }, [org, map])
  return null
}

export default function OrgMap({ orgs, selected, onSelect }: { orgs: AdminOrg[]; selected: string | null; onSelect: (id: string) => void }) {
  const sel = orgs.find((o) => o.id === selected) ?? null
  return (
    <BaseMap className="h-full w-full" zoom={11} zoomControl>
      <InvalidateOnResize />
      <FitSelected org={sel} />
      {orgs.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lng)).map((o) => {
        const color = ORG_TYPE_META[o.org_type]?.color ?? CATEGORY_META.other.color
        const isSel = o.id === selected
        const cat = o.categories?.[0] ?? 'other'
        return (
          <Fragment key={o.id}>
          <Circle center={[o.lat, o.lng]} radius={o.radius_m ?? 3000}
            pathOptions={{ color, weight: isSel ? 3 : 1.5, opacity: isSel ? 0.95 : 0.5, fillOpacity: isSel ? 0.16 : 0.05, dashArray: o.approved ? undefined : '6 6' }}
            eventHandlers={{ click: () => onSelect(o.id) }} />
          <Marker position={[o.lat, o.lng]} icon={dotIcon(cat, 26, isSel)} eventHandlers={{ click: () => onSelect(o.id) }} />
          </Fragment>
        )
      })}
    </BaseMap>
  )
}
