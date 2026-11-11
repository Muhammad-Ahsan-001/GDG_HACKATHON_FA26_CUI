import { Send, Siren, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { USER_URGENCY_META } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'
import { buzz } from '../../lib/voice/player'

const R = 48
const RING = 2 * Math.PI * R

/** Emergency: visible countdown, then auto-submit. Big Cancel (keep talking) and "Send now". */
export function EmergencyCountdown({ seconds = 3, onElapsed, onCancel }: {
  seconds?: number
  onElapsed: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [left, setLeft] = useState(seconds)
  const fired = useRef(false)
  const elapsed = useRef(onElapsed)
  useEffect(() => { elapsed.current = onElapsed }, [onElapsed])
  const color = USER_URGENCY_META.emergency.color

  useEffect(() => {
    const startedAt = performance.now()
    buzz([120, 60, 120])
    let shown = seconds
    const id = setInterval(() => {
      const remain = seconds - (performance.now() - startedAt) / 1000
      const n = Math.max(0, Math.ceil(remain))
      if (n !== shown) { shown = n; setLeft(n); if (n > 0) buzz(80) }
      if (remain <= 0 && !fired.current) {
        fired.current = true
        clearInterval(id)
        elapsed.current()
      }
    }, 100)
    return () => clearInterval(id)
  }, [seconds])

  const now = () => {
    if (fired.current) return
    fired.current = true
    elapsed.current()
  }

  return (
    <div className="-mx-4 flex flex-col items-center gap-3 border-t border-red-100 bg-red-50 px-4 pb-1 pt-4" role="alertdialog" aria-live="assertive"
      aria-label={t('report.emergencyCountdown', { n: left })}>
      <div className="flex w-full items-center gap-4">
        <div className="relative size-28 shrink-0">
          <svg viewBox="0 0 112 112" className="size-28 -rotate-90" aria-hidden>
            <circle cx="56" cy="56" r={R} fill="none" stroke="#ffffff" strokeWidth="9" />
            <circle
              cx="56" cy="56" r={R} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
              strokeDasharray={RING}
              className="awaaz-countdown-ring"
              style={{ ['--awaaz-ring' as string]: String(RING), ['--awaaz-dur' as string]: `${seconds}s` }}
            />
          </svg>
          <span key={left} className="awaaz-pop-in font-latin absolute inset-0 flex items-center justify-center text-5xl font-black tabular-nums" style={{ color }}>
            {left}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-lg font-black" style={{ color }}>
            <Siren className="size-6 shrink-0 animate-pulse" /> {t('report.emergencyTitle')}
          </div>
          <p className="mt-1 text-sm font-medium text-red-900">{t('report.emergencyBody', { n: left })}</p>
        </div>
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-white text-lg font-bold text-ink shadow-sm ring-2 ring-slate-200 active:scale-[0.98]"
        >
          <X className="size-6" /> {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={now}
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl text-lg font-bold text-white shadow-md active:scale-[0.98]"
          style={{ background: color }}
        >
          <Send className="size-6 rtl:-scale-x-100" /> {t('report.sendNowShort')}
        </button>
      </div>
    </div>
  )
}
