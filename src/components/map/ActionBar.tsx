import clsx from 'clsx'
import { Camera, Keyboard, LocateFixed, Mic, type LucideIcon } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import type { GeoState } from '../../hooks/useGeolocation'
import { useI18n } from '../../lib/i18n'
import { Spinner } from '../ui'

/** Selector of the main mic button (the first-run coach mark points at it and dismisses when it is tapped). */
export const MIC_SELECTOR = '[data-awaaz-mic]'

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
      <span aria-hidden className="rounded-full bg-white/95 px-2 text-xs font-bold text-ink shadow-sm">{label}</span>
    </div>
  )
}

/**
 * Bottom bar: the giant mic FAB in the centre (THE primary action), photo and keyboard beside it.
 * `micOverlay` renders on top of the mic (first-run coach mark).
 */
export const ActionBar = memo(function ActionBar({
  onVoice, onPhoto, onText, micOverlay,
}: { onVoice: () => void; onPhoto: () => void; onText: () => void; micOverlay?: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-[max(1.75rem,calc(env(safe-area-inset-bottom)_+_0.75rem))]">
      <div className="pointer-events-auto flex items-end gap-5">
        <SideButton icon={Camera} label={t('map.photo')} aria={t('map.photoAria')} onClick={onPhoto} />
        <div className="flex flex-col items-center gap-1.5">
          <span className="relative inline-flex">
            {/* two staggered breathing rings: the mic is unmistakably "the" button */}
            <span aria-hidden className="awaaz-mic-ring absolute inset-0 rounded-full bg-brand-500" />
            <span aria-hidden className="awaaz-mic-ring awaaz-mic-ring-2 absolute inset-0 rounded-full bg-brand-500" />
            <button
              type="button"
              data-awaaz-mic=""
              aria-label={t('map.speakAria')}
              title={t('map.speakAria')}
              onClick={onVoice}
              className="relative inline-flex size-[92px] items-center justify-center rounded-full bg-brand-600 text-white shadow-xl ring-[5px] ring-white transition active:scale-95"
            >
              <span aria-hidden className="absolute inset-[7px] rounded-full bg-brand-700" />
              <Mic className="relative size-11" strokeWidth={2.5} />
            </button>
            {micOverlay}
          </span>
          <span aria-hidden className="rounded-full bg-brand-700 px-3.5 py-0.5 text-base font-black text-white shadow-md">
            {t('map.speak')}
          </span>
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
