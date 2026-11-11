import clsx from 'clsx'
import { attributeIcon, sortAttributes, type AttributeMap } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'

const SEV = {
  danger: 'bg-red-50 text-red-800 ring-red-200',
  warn: 'bg-amber-50 text-amber-900 ring-amber-200',
  info: 'bg-slate-50 text-slate-800 ring-slate-200',
} as const

/** Icon-first chips for report attributes (pin sheet, dashboard card, report summary). */
export function AttributeChips({ attributes, compact, max, className }: {
  attributes: AttributeMap | null | undefined
  compact?: boolean
  max?: number
  className?: string
}) {
  const { lang } = useI18n()
  const list = sortAttributes(attributes)
  if (!list.length) return null
  const shown = typeof max === 'number' ? list.slice(0, max) : list
  return (
    <div className={clsx('flex flex-wrap gap-1.5', className)}>
      {shown.map((a) => {
        const Icon = attributeIcon(a.icon)
        const label = lang === 'ur' ? a.label_ur || a.label_en : a.label_en || a.label_ur
        const value = lang === 'ur' ? a.value_ur || a.value_en : a.value_en || a.value_ur
        return (
          <span
            key={a.key}
            title={`${label}: ${value}`}
            className={clsx('inline-flex items-center gap-1 rounded-full ring-1', SEV[a.severity] ?? SEV.info,
              compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm')}
          >
            <Icon className={compact ? 'size-3.5' : 'size-4'} />
            {!compact && <span className="opacity-70">{label}:</span>}
            <span className="font-semibold">{value}</span>
          </span>
        )
      })}
      {typeof max === 'number' && list.length > max && (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 text-xs font-semibold text-slate-600">+{list.length - max}</span>
      )}
    </div>
  )
}
