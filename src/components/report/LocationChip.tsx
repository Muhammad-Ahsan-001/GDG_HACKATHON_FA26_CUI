import clsx from 'clsx'
import { ChevronRight, Loader2, LocateFixed, MapPinCheck, MapPinned } from 'lucide-react'
import { memo } from 'react'
import { useI18n } from '../../lib/i18n'

export type LocKind = 'locating' | 'gps' | 'picked' | 'none'

/** Where the pin will go: GPS (green), a spot the user chose (blue) or not known yet (amber). Tap to choose the spot. */
export const LocationChip = memo(function LocationChip({ kind, accuracy, label, onOpen }: {
  kind: LocKind
  accuracy?: number
  label?: string
  onOpen: () => void
}) {
  const { t } = useI18n()
  const style = {
    locating: 'bg-slate-100 text-slate-700',
    gps: 'bg-green-50 text-green-800 ring-1 ring-green-200',
    picked: 'bg-blue-50 text-blue-800 ring-1 ring-blue-200',
    none: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200',
  }[kind]
  const Icon = kind === 'locating' ? Loader2 : kind === 'gps' ? LocateFixed : kind === 'picked' ? MapPinCheck : MapPinned
  const text = kind === 'locating' ? t('report.locating')
    : kind === 'gps' ? t('report.gps', { n: Math.max(1, Math.round(accuracy ?? 0)) })
      : kind === 'picked' ? (label || t('report.spotChosen')) : t('report.setSpot')

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${text} — ${t('report.changeSpot')}`}
      className={clsx('inline-flex min-h-11 w-full items-center gap-2 rounded-full px-3.5 text-sm font-semibold transition active:scale-[0.99]', style)}
    >
      <Icon className={clsx('size-5 shrink-0', kind === 'locating' && 'animate-spin')} />
      <span className="min-w-0 flex-1 truncate text-start" dir="auto">{text}</span>
      <span className="shrink-0 text-xs font-bold opacity-80">{t('report.changeSpot')}</span>
      <ChevronRight className="size-4 shrink-0 opacity-70 rtl:-scale-x-100" />
    </button>
  )
})
