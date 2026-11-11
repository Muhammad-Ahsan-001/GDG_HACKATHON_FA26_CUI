import { memo } from 'react'
import { CATEGORY_META, URGENCY_META } from '../../lib/categories'
import { STATUS_META } from '../../lib/status'
import type { Category, ReportStatus, Urgency } from '../../lib/types'

/** Badge diameter (px) by urgency — bigger = more urgent. */
const SIZE_BY_URGENCY: Record<Urgency, number> = { low: 34, medium: 40, high: 46, critical: 52 }
const SELECTED_SCALE = 1.3

export interface PinGlyphProps {
  category: Category
  urgency: Urgency
  status: ReportStatus
  reportCount: number
  selected?: boolean
  highlighted?: boolean
  /** override the urgency-based diameter (used by the list fallback) */
  size?: number
  /** disable the urgency pulse (e.g. inside lists) */
  noPulse?: boolean
}

/**
 * The visual pin: category-coloured round badge with a white icon, status ring,
 * report-count bubble, urgency pulse. Pure HTML/CSS, no shadows or filters.
 */
export const PinGlyph = memo(function PinGlyph({
  category, urgency, status, reportCount, selected, highlighted, size, noPulse,
}: PinGlyphProps) {
  const cat = CATEGORY_META[category] ?? CATEGORY_META.other
  const st = STATUS_META[status] ?? STATUS_META.unconfirmed
  const Icon = cat.icon
  const StatusIcon = st.icon
  const d = size ?? SIZE_BY_URGENCY[urgency] ?? SIZE_BY_URGENCY.medium
  const ring = d >= 44 ? 4 : 3
  const inner = d - ring * 2 - 4 // 2px white gap between ring and badge
  const urgent = (URGENCY_META[urgency]?.rank ?? 1) >= 2
  const pulse = !noPulse && urgent && (status === 'unconfirmed' || status === 'verified')
  const resolved = status === 'resolved'
  const disputed = status === 'disputed'
  const mini = status === 'verified' || status === 'in_progress' || resolved
  const miniSize = Math.max(16, Math.round(d * 0.42))

  return (
    <span
      className="relative block"
      style={{
        width: d,
        height: d,
        transform: selected ? `scale(${SELECTED_SCALE})` : undefined,
        transition: 'transform 160ms ease-out',
      }}
    >
      <span className={highlighted ? 'awaaz-pin-pop absolute inset-0 block' : 'absolute inset-0 block'}>
        {pulse && (
          <span aria-hidden className="awaaz-pin-pulse absolute inset-0 rounded-full" style={{ background: cat.color }} />
        )}
        {highlighted && (
          <span aria-hidden className="awaaz-pin-flash absolute inset-0 rounded-full" style={{ border: `3px solid ${cat.color}` }} />
        )}
        <span
          className="absolute inset-0 flex items-center justify-center rounded-full bg-white"
          style={{
            border: `${ring}px ${status === 'unconfirmed' ? 'dashed' : 'solid'} ${st.color}`,
            opacity: resolved ? 0.55 : disputed ? 0.8 : 1,
          }}
        >
          <span
            className="flex items-center justify-center rounded-full"
            style={{ width: inner, height: inner, background: cat.color }}
          >
            <Icon color="#fff" strokeWidth={2.4} style={{ width: inner * 0.58, height: inner * 0.58 }} />
          </span>
        </span>
        {disputed && (
          <span
            aria-hidden
            // physical left/top centring is direction-agnostic (translate is always from the left edge)
            className="absolute block rounded-full"
            style={{
              width: d * 1.05,
              height: ring,
              left: '50%',
              top: '50%',
              background: st.color,
              transform: 'translate(-50%, -50%) rotate(-45deg)',
            }}
          />
        )}
        {mini && (
          <span
            aria-hidden
            className="absolute -bottom-1 -end-1 flex items-center justify-center rounded-full bg-white"
            style={{ width: miniSize, height: miniSize, color: st.color, border: `2px solid ${st.color}` }}
          >
            <StatusIcon strokeWidth={3} style={{ width: miniSize * 0.68, height: miniSize * 0.68 }} />
          </span>
        )}
        {reportCount > 1 && (
          <span
            aria-hidden
            className="font-latin absolute -top-1.5 -end-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1 text-[11px] font-bold text-white"
            style={{ lineHeight: 1 }}
          >
            {reportCount > 99 ? '99+' : reportCount}
          </span>
        )}
      </span>
    </span>
  )
})
