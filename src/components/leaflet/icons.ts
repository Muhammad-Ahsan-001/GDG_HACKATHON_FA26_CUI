// Leaflet marker glyphs built from vanilla `lucide` icon nodes (no React render per marker = fast on cheap phones).
import L from 'leaflet'
import {
  Check, CheckCheck, CircleHelp, Droplets, Flame, HeartPulse, ShieldAlert, Slash, TriangleAlert, Utensils, Waves, Wrench,
} from 'lucide'
import { CATEGORY_META } from '../../lib/categories'
import type { Category, ReportStatus, Urgency } from '../../lib/types'

type IconNode = [tag: string, attrs: Record<string, string | number>][]

const CATEGORY_NODES: Record<Category, IconNode> = {
  hazard: TriangleAlert as IconNode,
  fire: Flame as IconNode,
  flood: Waves as IconNode,
  water: Droplets as IconNode,
  food: Utensils as IconNode,
  health: HeartPulse as IconNode,
  safety: ShieldAlert as IconNode,
  other: CircleHelp as IconNode,
}

const STATUS_NODES: Partial<Record<ReportStatus, IconNode>> = {
  verified: Check as IconNode,
  disputed: Slash as IconNode,
  in_progress: Wrench as IconNode,
  resolved: CheckCheck as IconNode,
}

const esc = (v: string | number) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** Render a lucide icon node to an inline SVG string. */
export function svg(node: IconNode, size: number, color = 'currentColor', strokeWidth = 2.25): string {
  const children = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`
}

export function categorySvg(category: Category, size: number, color = '#fff'): string {
  return svg(CATEGORY_NODES[category] ?? CATEGORY_NODES.other, size, color)
}

const URGENCY_SIZE: Record<Urgency, number> = { low: 34, medium: 38, high: 44, critical: 48 }

export interface PinIconOpts {
  category: Category
  status: ReportStatus
  urgency: Urgency
  count?: number
  selected?: boolean
  /** pulse ring (new / urgent) */
  pulse?: boolean
  /** brief highlight after a realtime change */
  flash?: boolean
}

const iconCache = new Map<string, L.DivIcon>()

/**
 * Pin = round badge in category colour + white category icon, a status ring
 * (unconfirmed dashed amber, verified green + check, disputed grey + slash, in progress blue + wrench,
 * resolved faded + double check), and a report-count bubble when count > 1. Styles: ./leaflet.css (.awz-pin*).
 */
export function pinIcon(o: PinIconOpts): L.DivIcon {
  const key = `${o.category}|${o.status}|${o.urgency}|${o.count ?? 1}|${o.selected ? 1 : 0}|${o.pulse ? 1 : 0}|${o.flash ? 1 : 0}`
  const hit = iconCache.get(key)
  if (hit) return hit
  const base = URGENCY_SIZE[o.urgency] ?? 38
  const size = o.selected ? Math.round(base * 1.3) : base
  const color = CATEGORY_META[o.category]?.color ?? CATEGORY_META.other.color
  const statusNode = STATUS_NODES[o.status]
  const html = `
    <div class="awz-pin awz-st-${o.status}${o.selected ? ' awz-sel' : ''}${o.pulse ? ' awz-pulse' : ''}${o.flash ? ' awz-flash' : ''}"
         style="--c:${color};--s:${size}px">
      <span class="awz-pin-ring"></span>
      <span class="awz-pin-body">${categorySvg(o.category, Math.round(size * 0.52))}</span>
      ${statusNode ? `<span class="awz-pin-status">${svg(statusNode, 11, '#fff', 3)}</span>` : ''}
      ${o.count && o.count > 1 ? `<span class="awz-pin-count">${o.count > 99 ? '99+' : o.count}</span>` : ''}
    </div>`
  const icon = L.divIcon({
    html,
    className: 'awz-pin-wrap',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
  iconCache.set(key, icon)
  return icon
}

/** Small plain category dot (dashboards, pickers). */
export function dotIcon(category: Category, size = 30, selected = false): L.DivIcon {
  const s = selected ? Math.round(size * 1.3) : size
  const color = CATEGORY_META[category]?.color ?? CATEGORY_META.other.color
  return L.divIcon({
    html: `<div class="awz-pin${selected ? ' awz-sel' : ''}" style="--c:${color};--s:${s}px"><span class="awz-pin-body">${categorySvg(category, Math.round(s * 0.55))}</span></div>`,
    className: 'awz-pin-wrap',
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  })
}

/** Blue "you are here" dot. */
export const userDotIcon = L.divIcon({
  html: '<div class="awz-user-dot"><span></span></div>',
  className: 'awz-pin-wrap',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

/** Draggable location-pick pin (report flow, org registration). */
export const pickIcon = L.divIcon({
  html: '<div class="awz-pick"><span></span></div>',
  className: 'awz-pin-wrap',
  iconSize: [36, 46],
  iconAnchor: [18, 44],
})
