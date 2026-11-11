// Role + organisation-type presentation metadata for the auth/account pages.
// Org-type colours come from the category they mainly serve (src/lib/categories.ts) so colour meaning stays consistent.
import {
  Ambulance, Droplet, FireExtinguisher, HandHeart, Megaphone, Shield, ShieldCheck, Siren, Soup, Stethoscope, Tent,
  type LucideIcon,
} from 'lucide-react'
import { CATEGORY_META } from '../../lib/categories'
import { NGO_ORG_TYPES, RESPONDER_ORG_TYPES, type Category, type OrgType, type Role } from '../../lib/types'

export interface RoleMeta { icon: LucideIcon; color: string; soft: string }

export const ROLE_META: Record<Role, RoleMeta> = {
  citizen:   { icon: Megaphone,   color: '#0F766E', soft: '#CCFBF1' },
  ngo:       { icon: HandHeart,   color: '#BE185D', soft: '#FCE7F3' },
  responder: { icon: Siren,       color: '#C2410C', soft: '#FFEDD5' },
  admin:     { icon: ShieldCheck, color: '#334155', soft: '#E2E8F0' },
}

export const SIGNUP_ROLES: Exclude<Role, 'admin'>[] = ['citizen', 'ngo', 'responder']

export interface OrgTypeMeta { icon: LucideIcon; color: string; soft: string; defaultCategories: Category[] }

const fromCategory = (c: Category) => ({ color: CATEGORY_META[c].color, soft: CATEGORY_META[c].soft })

export const ORG_TYPE_META: Record<OrgType, OrgTypeMeta> = {
  rescue_1122: { icon: Ambulance,        ...fromCategory('hazard'), defaultCategories: ['hazard', 'fire', 'flood', 'health'] },
  fire:        { icon: FireExtinguisher, ...fromCategory('fire'),   defaultCategories: ['fire'] },
  police:      { icon: Shield,           ...fromCategory('safety'), defaultCategories: ['safety'] },
  water:       { icon: Droplet,          ...fromCategory('water'),  defaultCategories: ['water', 'flood'] },
  shelter:     { icon: Tent,             ...fromCategory('flood'),  defaultCategories: ['food', 'flood'] },
  food_bank:   { icon: Soup,             ...fromCategory('food'),   defaultCategories: ['food'] },
  health_ngo:  { icon: Stethoscope,      ...fromCategory('health'), defaultCategories: ['health'] },
}

/** Org types a role may register (mirrors the register_organization RPC rule). */
export function orgTypesFor(role: Role | null | undefined): OrgType[] {
  if (role === 'ngo') return NGO_ORG_TYPES
  if (role === 'responder') return RESPONDER_ORG_TYPES
  return []
}
