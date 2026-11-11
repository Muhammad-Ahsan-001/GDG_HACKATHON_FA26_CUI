import clsx from 'clsx'
import { Hourglass, Timer, TimerOff } from 'lucide-react'
import { useMemo } from 'react'
import { useI18n } from '../../lib/i18n'
import { FOOD_TONE, foodTone, formatFoodClock, isolateLtr, useTicker } from './time'

const FAST_BELOW_MS = 65 * 60_000

export interface FoodCountdownProps {
  /** clusters.safe_until (ISO). Renders nothing when missing or unparsable. */
  until: string | null | undefined
  /** when the food was reported (created_at) — draws a shrinking "time left" bar in the block variant */
  from?: string | null
  /** 'block' = big panel clock (pin sheet), 'pill' = one-line chip (cards, alerts) */
  variant?: 'block' | 'pill'
  className?: string
}

/**
 * Live countdown to `safe_until`: "mm:ss" under an hour, "h:mm" otherwise.
 * Green → amber (< 60 min) → red (< 20 min) → grey "Expired". One shared ticker: 15 s while far away, 1 s in the last hour.
 */
export function FoodCountdown({ until, from, variant = 'block', className }: FoodCountdownProps) {
  const { t } = useI18n()
  const end = useMemo(() => (until ? new Date(until).getTime() : Number.NaN), [until])
  const start = useMemo(() => (from ? new Date(from).getTime() : Number.NaN), [from])
  const valid = Number.isFinite(end)

  const coarse = useTicker(15_000, valid)
  const fast = valid && end - coarse < FAST_BELOW_MS && end > coarse - 1000
  const fine = useTicker(1000, fast)
  const now = fast ? Math.max(coarse, fine) : coarse
  if (!valid) return null

  const left = end - now
  const tone = foodTone(left)
  const { color, soft } = FOOD_TONE[tone]
  const expired = tone === 'expired'
  const { clock, unit } = formatFoodClock(left)
  const unitText = unit === 'min' ? t('alerts.food_unitMin') : t('alerts.food_unitHours')
  const aria = expired ? t('alerts.food_expiredLong') : `${t('alerts.food_safeFor')} ${clock} ${unitText}`

  if (variant === 'pill') {
    const Icon = expired ? TimerOff : Hourglass
    return (
      <span
        role="timer"
        aria-live="off"
        aria-label={aria}
        className={clsx('inline-flex items-center gap-1 rounded-full border-2 px-2 py-0.5 text-sm font-bold', className)}
        style={{ borderColor: color, color, background: soft }}
      >
        <Icon className={clsx('size-4 shrink-0', tone === 'urgent' && 'motion-safe:animate-pulse')} aria-hidden />
        {expired ? t('alerts.food_expired') : (
          <>
            <span className="font-latin tabular-nums">{isolateLtr(clock)}</span>
            <span className="text-xs font-semibold">{unitText} {t('alerts.food_left')}</span>
          </>
        )}
      </span>
    )
  }

  const total = Number.isFinite(start) && end > start ? end - start : null
  const frac = total ? Math.max(0, Math.min(1, left / total)) : null
  const Icon = expired ? TimerOff : Timer

  return (
    <div
      role="timer"
      aria-live="off"
      aria-label={aria}
      className={clsx('flex flex-col gap-2 rounded-2xl p-3', className)}
      style={{ background: soft }}
    >
      <div className="flex items-center gap-3">
        <span
          className={clsx('inline-flex size-12 shrink-0 items-center justify-center rounded-full text-white', tone === 'urgent' && 'motion-safe:animate-pulse')}
          style={{ background: color }}
          aria-hidden
        >
          <Icon className="size-7" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-700">
            {expired ? t('alerts.food_expiredLong') : tone === 'urgent' ? t('alerts.food_hurry') : t('alerts.food_safeFor')}
          </div>
          {expired ? (
            <div className="text-2xl font-black leading-tight" style={{ color }}>{t('alerts.food_expired')}</div>
          ) : (
            <div className="flex items-baseline gap-1.5" style={{ color }}>
              <span className="font-latin text-4xl leading-none font-black tabular-nums">{isolateLtr(clock)}</span>
              <span className="text-base font-bold">{unitText}</span>
            </div>
          )}
        </div>
      </div>
      {frac !== null && !expired && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-white/80" aria-hidden>
          <div className="h-full rounded-full transition-[width] duration-1000 ease-linear" style={{ width: `${frac * 100}%`, background: color }} />
        </div>
      )}
    </div>
  )
}
