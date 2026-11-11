import { Radar } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import type { MapPin } from '../../lib/types'
import { useFormatDistance } from '../map/useFormatDistance'

/** Same radius the server uses for nearby alerts (NEARBY_RADIUS_M). */
export const NEARBY_RADIUS_M = 1000

/** Router state set by <NearbyAlert/> when "View on map" is tapped. */
export interface NearbyNavState { awaazAlert?: { distance_m?: number | null; notification_id?: string } }

export function nearbyNavState(distance_m: number | null, notification_id: string): NearbyNavState {
  return { awaazAlert: { distance_m, notification_id } }
}

/**
 * Pin sheet context: "This is 350 m from you — stay safe and avoid the area." Shown for live (not resolved) danger pins
 * within the alert radius that are verified or high-urgency, and always when the sheet was opened from a nearby alert.
 */
export function NearbyPinBanner({ pin, distanceM }: {
  pin: Pick<MapPin, 'category' | 'status' | 'urgency'>
  /** live distance from the user's GPS fix, when known */
  distanceM: number | null
}) {
  const { t } = useI18n()
  const fmt = useFormatDistance()
  const state = useLocation().state as NearbyNavState | null
  const fromAlert = Boolean(state?.awaazAlert)
  const dist = distanceM ?? state?.awaazAlert?.distance_m ?? null

  if (pin.category === 'food' || pin.status === 'resolved') return null
  const near = dist !== null && dist <= NEARBY_RADIUS_M
  const serious = pin.status === 'verified' || pin.urgency === 'high' || pin.urgency === 'critical'
  if (!fromAlert && !(near && serious)) return null

  const cat = CATEGORY_META[pin.category] ?? CATEGORY_META.other
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl border-s-[6px] p-3"
      style={{ background: cat.soft, borderInlineStartColor: cat.color }}
    >
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white" style={{ background: cat.color }} aria-hidden>
        <Radar className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-ink">{t('alerts.nearby_dangerTitle')}</div>
        <p className="text-sm font-semibold text-slate-700">
          {dist !== null ? t('alerts.nearby_pinDistance', { d: fmt(dist) }) : t('alerts.nearby_pinWithin')}
        </p>
        {fromAlert && <p className="mt-0.5 text-xs text-slate-600">{t('alerts.nearby_whyAlerted')}</p>}
      </div>
    </div>
  )
}
