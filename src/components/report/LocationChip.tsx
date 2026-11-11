import clsx from 'clsx'
import { Loader2, LocateFixed, MapPin, MapPinned, PencilLine, RotateCcw } from 'lucide-react'
import type { GeoFix, GeoState } from '../../hooks/useGeolocation'
import { useI18n } from '../../lib/i18n'

/** Where the pin will go: GPS (green), the typed place (blue) or the map centre (amber). Tap to retry GPS. */
export function LocationChip({ state, fix, typed, addressOpen, onRetry, onToggleAddress }: {
  state: GeoState
  fix: GeoFix | null
  typed: boolean
  addressOpen: boolean
  onRetry: () => void
  onToggleAddress: () => void
}) {
  const { t } = useI18n()
  const gpsOk = state === 'ok' && fix
  const kind = state === 'locating' ? 'locating' : gpsOk ? 'gps' : typed ? 'typed' : 'map'
  const style = {
    locating: 'bg-slate-100 text-slate-700',
    gps: 'bg-green-100 text-green-800',
    typed: 'bg-blue-100 text-blue-800',
    map: 'bg-amber-100 text-amber-800',
  }[kind]
  const Icon = kind === 'locating' ? Loader2 : kind === 'gps' ? LocateFixed : kind === 'typed' ? MapPinned : MapPin
  const label = kind === 'locating' ? t('report.locating')
    : kind === 'gps' && fix ? t('report.gps', { n: Math.max(1, Math.round(fix.accuracy)) })
      : kind === 'typed' ? t('report.typedPlace') : t('report.mapCentre')
  const canRetry = kind === 'map' || kind === 'typed'

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={canRetry ? onRetry : undefined}
        aria-label={canRetry ? `${label} — ${t('report.retryGps')}` : label}
        title={canRetry ? t('report.retryGps') : undefined}
        aria-live="polite"
        className={clsx('inline-flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-full px-4 text-sm font-semibold', style,
          !canRetry && 'cursor-default')}
      >
        <Icon className={clsx('size-5 shrink-0', kind === 'locating' && 'animate-spin')} />
        <span className="truncate" dir="auto">{label}</span>
        {canRetry && <RotateCcw className="ms-auto size-4 shrink-0 opacity-70" />}
      </button>
      <button
        type="button"
        onClick={onToggleAddress}
        aria-expanded={addressOpen}
        aria-label={t('report.addPlace')}
        title={t('report.addPlace')}
        className={clsx(
          'inline-flex min-h-12 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold',
          addressOpen ? 'bg-brand-700 text-white' : 'bg-slate-100 text-ink',
        )}
      >
        <PencilLine className="size-5" />
        <span className="hidden min-[380px]:inline">{t('report.addPlace')}</span>
      </button>
    </div>
  )
}
