import clsx from 'clsx'
import { Camera, Keyboard, LocateFixed, Mic, type LucideIcon } from 'lucide-react'
import { memo } from 'react'
import type { GeoState } from '../../hooks/useGeolocation'
import { useI18n } from '../../lib/i18n'
import { Spinner } from '../ui'

function SideButton({ icon: Icon, label, aria, onClick }: { icon: LucideIcon; label: string; aria: string; onClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        aria-label={aria}
        title={aria}
        onClick={onClick}
        className="inline-flex size-[60px] items-center justify-center rounded-full border border-slate-200 bg-white text-brand-700 shadow-md transition active:scale-95"
      >
        <Icon className="size-7" strokeWidth={2.2} />
      </button>
      <span aria-hidden className="rounded-full bg-white/90 px-2 text-xs font-bold text-ink">{label}</span>
    </div>
  )
}

/** Bottom bar: giant mic FAB in the centre, photo and keyboard beside it. */
export const ActionBar = memo(function ActionBar({
  onVoice, onPhoto, onText,
}: { onVoice: () => void; onPhoto: () => void; onText: () => void }) {
  const { t } = useI18n()
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-[max(1.75rem,calc(env(safe-area-inset-bottom)_+_0.75rem))]">
      <div className="pointer-events-auto flex items-end gap-6">
        <SideButton icon={Camera} label={t('map.photo')} aria={t('map.photoAria')} onClick={onPhoto} />
        <div className="flex flex-col items-center gap-1">
          <span className="relative inline-flex">
            <span aria-hidden className="awaaz-mic-ring absolute inset-0 rounded-full bg-brand-500" />
            <button
              type="button"
              aria-label={t('map.speakAria')}
              title={t('map.speakAria')}
              onClick={onVoice}
              className="relative inline-flex size-[84px] items-center justify-center rounded-full bg-brand-600 text-white shadow-lg ring-4 ring-white transition active:scale-95"
            >
              <Mic className="size-10" strokeWidth={2.4} />
            </button>
          </span>
          <span aria-hidden className="rounded-full bg-white/90 px-2.5 text-sm font-black text-brand-900">{t('map.speak')}</span>
        </div>
        <SideButton icon={Keyboard} label={t('map.type')} aria={t('map.typeAria')} onClick={onText} />
      </div>
    </div>
  )
})

/** Floating "locate me" button. */
export const LocateButton = memo(function LocateButton({
  state, onLocate, className,
}: { state: GeoState; onLocate: () => void; className?: string }) {
  const { t } = useI18n()
  const label = state === 'locating' ? t('map.locating') : t('map.locate')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onLocate}
      disabled={state === 'locating'}
      className={clsx(
        'inline-flex size-14 items-center justify-center rounded-full border border-slate-200 bg-white shadow-md transition active:scale-95 disabled:opacity-80',
        state === 'ok' ? 'text-blue-600' : state === 'denied' ? 'text-slate-400' : 'text-ink',
        className,
      )}
    >
      {state === 'locating' ? <Spinner className="size-6 text-blue-600" /> : <LocateFixed className="size-7" />}
    </button>
  )
})
