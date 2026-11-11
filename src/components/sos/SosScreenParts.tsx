// Building blocks of the light, silent SOS screen (the Disguise overlay alone stays black: it hides the screen).
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { Spinner } from '../ui'
import { SOS_HOLD_MS } from './sosClient'
import { useHold } from './useHold'

/** Pulsing "listening" ring; the inner disc breathes with the mic level (DOM style writes, no re-renders). */
export function ListeningRing({ color, icon: Icon, pulse, readLevel }: {
  color: string
  icon: LucideIcon
  pulse: boolean
  readLevel?: () => number
}) {
  const inner = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = inner.current
    if (!readLevel || !el) return
    let raf = 0
    let last = 0
    let smooth = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 90) return // ~11 fps is plenty
      last = now
      smooth = smooth * 0.55 + readLevel() * 0.45
      el.style.transform = `scale(${(1 + smooth * 0.22).toFixed(3)})`
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); el.style.transform = '' }
  }, [readLevel])

  return (
    <div className="relative size-52 shrink-0" aria-hidden>
      {pulse && (
        <>
          <span className="sos-pulse absolute inset-0 rounded-full" style={{ background: color }} />
          <span className="sos-pulse sos-pulse-delay absolute inset-0 rounded-full" style={{ background: color }} />
        </>
      )}
      <span className="absolute inset-4 rounded-full opacity-25 transition-colors duration-500" style={{ background: color }} />
      <span
        ref={inner}
        className="absolute inset-9 flex items-center justify-center rounded-full text-white shadow-2xl ring-8 ring-white transition-[transform,background-color] duration-100"
        style={{ background: color }}
      >
        <Icon className="size-16" />
      </span>
    </div>
  )
}

/** mm:ss since `since` (own 1 s timer so the page does not re-render every second). */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return <span dir="ltr" className={clsx('font-latin tabular-nums', className)}>{text}</span>
}

/** Full-width press-and-hold button (fill grows from the start side). Used for "I'm safe". */
export function HoldButton({ label, sub, icon: Icon, color, onDone, busy, disabled }: {
  label: string
  sub: string
  icon: LucideIcon
  color: string
  onDone: () => void
  busy?: boolean
  disabled?: boolean
}) {
  const { t } = useI18n()
  const { holding, hint, bind } = useHold(SOS_HOLD_MS, onDone, { disabled: disabled || busy })
  return (
    <button
      type="button"
      {...bind}
      disabled={disabled}
      aria-label={`${label}. ${sub}`}
      className={clsx(
        'relative flex min-h-16 w-full select-none items-center justify-center overflow-hidden rounded-3xl border-2 bg-white px-5 py-3 shadow-sm transition-colors',
        '[touch-action:none] [-webkit-touch-callout:none] [-webkit-user-select:none] disabled:opacity-60',
      )}
      style={{ borderColor: color, color: holding ? '#fff' : color }}
    >
      <span
        aria-hidden
        className="absolute inset-0 origin-left rtl:origin-right"
        style={{
          background: color,
          transform: holding ? 'scaleX(1)' : 'scaleX(0)',
          transition: holding ? `transform ${SOS_HOLD_MS}ms linear` : 'transform 160ms ease-out',
        }}
      />
      <span className="relative flex items-center gap-3 text-start">
        {busy ? <Spinner className="size-7" /> : <Icon className="size-7 shrink-0" />}
        <span>
          <span className="block text-lg font-black leading-tight">{label}</span>
          <span className={clsx('block text-sm font-semibold', holding ? 'text-white/85' : 'text-slate-600')}>{holding || hint ? t('sos.keepHolding') : sub}</span>
        </span>
      </span>
    </button>
  )
}

/**
 * Disguise: an all-black screen over everything (recording continues underneath).
 * Three taps within ~1.2 s (or Esc) bring the SOS screen back. The hint fades out after a moment.
 */
export function DisguiseOverlay({ onReveal }: { onReveal: () => void }) {
  const { t } = useI18n()
  const taps = useRef<number[]>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onReveal() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onReveal])

  return (
    <div
      className="fixed inset-0 z-[100] flex cursor-none items-end justify-center bg-black pb-16 select-none [touch-action:manipulation]"
      onPointerDown={() => {
        const now = performance.now()
        const recent = taps.current.filter((x) => now - x < 1200)
        recent.push(now)
        taps.current = recent
        if (recent.length >= 3) { taps.current = []; onReveal() }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="sos-fade-out px-6 text-center text-sm text-white/35">{t('sos.disguiseHint')}</p>
    </div>
  )
}
