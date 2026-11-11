import clsx from 'clsx'
import { Siren } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useI18n } from '../../lib/i18n'
import { SOS_RED } from './meta'
import { SOS_HOLD_MS } from './sosClient'
import { useHold } from './useHold'

/**
 * Red round SOS button. Press and hold 1.5 s (a white ring fills, short vibration) → /sos?trigger=button.
 * The hold prevents accidental alerts. Used on MapPage (top, start side) and MePage.
 */
export function SosButton({ size = 64, className }: { size?: number; className?: string }) {
  const { t } = useI18n()
  const nav = useNavigate()
  const { session, signInAnonymously } = useAuth()
  const going = useRef(false)

  const go = useCallback(async () => {
    if (going.current) return
    going.current = true
    try {
      // SOS works for anonymous users; make sure there is a session so /sos does not bounce to /login
      if (!session) await signInAnonymously().catch(() => undefined)
      nav('/sos?trigger=button')
    } finally {
      going.current = false
    }
  }, [session, signInAnonymously, nav])

  const { holding, hint, bind } = useHold(SOS_HOLD_MS, () => { void go() })

  const stroke = Math.max(4, Math.round(size * 0.07))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const iconSize = Math.round(size * 0.34)
  const fontSize = Math.max(11, Math.round(size * 0.2))

  return (
    <div className={clsx('relative inline-flex shrink-0 flex-col items-center', className)}>
      <button
        type="button"
        {...bind}
        aria-label={t('sos.holdLabel')}
        title={t('sos.holdLabel')}
        className={clsx(
          'relative inline-flex select-none items-center justify-center rounded-full text-white shadow-lg ring-4 transition-transform duration-150',
          '[touch-action:none] [-webkit-touch-callout:none] [-webkit-user-select:none]',
          holding ? 'scale-95' : 'active:scale-95',
        )}
        style={{ width: size, height: size, background: SOS_RED, ['--tw-ring-color' as string]: `${SOS_RED}40` }}
      >
        <svg className="pointer-events-none absolute inset-0 -rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={holding ? 0 : c}
            style={{ transition: holding ? `stroke-dashoffset ${SOS_HOLD_MS}ms linear` : 'stroke-dashoffset 160ms ease-out' }}
          />
        </svg>
        <span className="pointer-events-none flex flex-col items-center gap-0.5 leading-none" aria-hidden>
          <Siren style={{ width: iconSize, height: iconSize }} />
          <span className="font-latin font-black tracking-wide" style={{ fontSize, lineHeight: 1 }}>{t('sos.sos')}</span>
        </span>
      </button>
      {(hint || holding) && (
        <span
          role="status"
          className="pointer-events-none absolute top-full z-10 mt-1.5 whitespace-nowrap rounded-full bg-slate-900 px-3 py-1 text-xs font-bold text-white shadow-lg"
        >
          {holding ? t('sos.keepHolding') : t('sos.tapHint')}
        </span>
      )}
    </div>
  )
}
