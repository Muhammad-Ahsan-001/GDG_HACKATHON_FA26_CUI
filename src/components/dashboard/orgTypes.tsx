import { Ambulance, FireExtinguisher, HandHeart, House, Droplet, ShieldCheck, Stethoscope, type LucideIcon } from 'lucide-react'
import { useI18n } from '../../lib/i18n'
import type { OrgType } from '../../lib/types'

/** Organisation-type glyphs (org types are not report categories, so they live here). */
const ORG_TYPE_ICON: Record<OrgType, LucideIcon> = {
  shelter: House,
  food_bank: HandHeart,
  health_ngo: Stethoscope,
  rescue_1122: Ambulance,
  fire: FireExtinguisher,
  police: ShieldCheck,
  water: Droplet,
}

export function OrgTypeIcon({ type, size = 44 }: { type: OrgType; size?: number }) {
  const Icon = ORG_TYPE_ICON[type] ?? House
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-brand-700 text-white"
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  )
}

export function useOrgTypeLabel() {
  const { t } = useI18n()
  return (type: OrgType) => t(`dashboard.orgType_${type}`)
}
