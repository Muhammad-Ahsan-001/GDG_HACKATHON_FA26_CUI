import type { Category, MyAssignment, Organization } from '../../lib/types'

/**
 * A `my_assignments` row. The view returns a few columns beyond the contract list
 * (see supabase/migrations/*_views.sql); they are optional here so the UI never depends on them.
 */
export interface DashAssignment extends MyAssignment {
  report_id?: string | null
  reporter_count?: number
  confirm_count?: number
  dispute_count?: number
  claimed_org_id?: string | null
  claimed_org_name?: string | null
  address_text?: string | null
  cluster_created_at?: string
  last_report_at?: string
}

export type AssignmentActionKind = 'claim' | 'start' | 'resolve'

/** List tabs: New = alerted, Active = claimed + in_progress, Done = resolved. */
export type DashTab = 'new' | 'active' | 'done'

export type CategoryFilter = Category | 'all'

/** An organisation as shown on the dashboard (row of `org_directory`). */
export type DashOrg = Organization & { phone?: string | null }

/** Camera target for the map (a new object = pan again). */
export interface MapFocus { lat: number; lng: number }

export function tabOf(a: Pick<MyAssignment, 'status'>): DashTab {
  if (a.status === 'alerted') return 'new'
  if (a.status === 'resolved') return 'done'
  return 'active'
}
