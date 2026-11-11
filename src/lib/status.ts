import { CheckCheck, CircleCheck, CircleDashed, CircleSlash, Wrench, type LucideIcon } from 'lucide-react'
import type { AssignmentStatus, ReportStatus } from './types'

export interface StatusMeta { color: string; soft: string; icon: LucideIcon; en: string; ur: string }

/** Single source of truth for report/cluster status colour + icon. */
export const STATUS_META: Record<ReportStatus, StatusMeta> = {
  unconfirmed: { color: '#B45309', soft: '#FEF3C7', icon: CircleDashed, en: 'Unconfirmed', ur: 'غیر تصدیق شدہ' },
  verified:    { color: '#15803D', soft: '#DCFCE7', icon: CircleCheck,  en: 'Verified',    ur: 'تصدیق شدہ' },
  disputed:    { color: '#6B7280', soft: '#F3F4F6', icon: CircleSlash,  en: 'Disputed',    ur: 'متنازعہ' },
  in_progress: { color: '#1D4ED8', soft: '#DBEAFE', icon: Wrench,       en: 'In progress', ur: 'کام جاری' },
  resolved:    { color: '#047857', soft: '#D1FAE5', icon: CheckCheck,   en: 'Resolved',    ur: 'حل ہو گیا' },
}

export const ASSIGNMENT_META: Record<AssignmentStatus, { color: string; en: string; ur: string }> = {
  alerted:     { color: '#DC2626', en: 'New alert',   ur: 'نیا الرٹ' },
  claimed:     { color: '#B45309', en: 'Claimed',     ur: 'ذمہ لے لیا' },
  in_progress: { color: '#1D4ED8', en: 'In progress', ur: 'کام جاری' },
  resolved:    { color: '#047857', en: 'Resolved',    ur: 'حل ہو گیا' },
}
