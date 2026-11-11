import { Ambulance, Droplet, FireExtinguisher, HandHeart, House, Siren, Stethoscope, type LucideIcon } from 'lucide-react'
import type { OrgType } from '../../lib/types'

/** Icon + accent for responder / NGO types shown in the report result ("Rescue 1122 alerted"). */
export const ORG_META: Record<OrgType, { icon: LucideIcon; color: string }> = {
  rescue_1122: { icon: Ambulance, color: '#DC2626' },
  fire: { icon: FireExtinguisher, color: '#B91C1C' },
  police: { icon: Siren, color: '#1D4ED8' },
  water: { icon: Droplet, color: '#0E7490' },
  shelter: { icon: House, color: '#7C3AED' },
  food_bank: { icon: HandHeart, color: '#15803D' },
  health_ngo: { icon: Stethoscope, color: '#BE185D' },
}

export function orgMeta(type: string) {
  return ORG_META[type as OrgType] ?? { icon: House, color: '#475569' }
}
