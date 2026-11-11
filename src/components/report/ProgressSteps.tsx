import clsx from 'clsx'
import { Brain, Check, CloudUpload, Ear, Lightbulb, MapPin, ScanSearch, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'

export type StepKey = 'upload' | 'listen' | 'understand' | 'duplicates' | 'pin'

const STEP_META: Record<StepKey, { icon: LucideIcon; label: string }> = {
  upload: { icon: CloudUpload, label: 'report.stepUpload' },
  listen: { icon: Ear, label: 'report.stepListen' },
  understand: { icon: Brain, label: 'report.stepUnderstand' },
  duplicates: { icon: ScanSearch, label: 'report.stepDuplicates' },
  pin: { icon: MapPin, label: 'report.stepPin' },
}
const TIPS = ['report.tip1', 'report.tip2', 'report.tip3', 'report.tip4']

/** Animated "what is happening" list while process-report runs. `active` = index of the running step. */
export function ProgressSteps({ steps, active }: { steps: StepKey[]; active: number }) {
  const { t } = useI18n()
  const [tip, setTip] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 4500)
    return () => clearInterval(id)
  }, [])
  const current = steps[Math.min(active, steps.length - 1)]
  const BigIcon = STEP_META[current].icon

  return (
    <div className="flex flex-col items-center gap-4 py-2" aria-live="polite" aria-busy={active < steps.length}>
      <div className="relative flex size-28 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/20 [animation-duration:1.8s]" aria-hidden />
        <span className="absolute inset-2 rounded-full bg-brand-100" aria-hidden />
        <span key={current} className="relative inline-flex size-20 items-center justify-center rounded-full bg-brand-700 text-white shadow-lg">
          <BigIcon className="size-10 animate-pulse" />
        </span>
      </div>
      <div className="text-center">
        <div className="text-lg font-bold">{t('report.workingTitle')}</div>
        <div className="text-sm text-slate-500">{t('report.keepOpen')}</div>
      </div>

      <ol className="flex w-full flex-col gap-1.5">
        {steps.map((s, i) => {
          const Icon = STEP_META[s].icon
          const done = i < active
          const running = i === active
          return (
            <li
              key={s}
              className={clsx(
                'flex min-h-12 items-center gap-3 rounded-2xl px-3 transition-colors',
                running ? 'bg-brand-50 text-brand-900' : done ? 'text-green-700' : 'text-slate-400',
              )}
            >
              <span className={clsx(
                'inline-flex size-9 shrink-0 items-center justify-center rounded-full',
                done ? 'bg-green-600 text-white' : running ? 'bg-brand-700 text-white' : 'bg-slate-100',
              )}>
                {done ? <Check className="size-5" strokeWidth={3} /> : <Icon className={clsx('size-5', running && 'animate-pulse')} />}
              </span>
              <span className={clsx('flex-1 font-semibold', running && 'text-base')}>{t(STEP_META[s].label)}</span>
              {running && (
                <span className="flex gap-1" aria-hidden>
                  {[0, 1, 2].map((d) => (
                    <span key={d} className="size-1.5 animate-bounce rounded-full bg-brand-700" style={{ animationDelay: `${d * 150}ms` }} />
                  ))}
                </span>
              )}
            </li>
          )
        })}
      </ol>

      <p key={tip} className="flex w-full items-start gap-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <Lightbulb className="mt-0.5 size-5 shrink-0" /> <span>{t(TIPS[tip])}</span>
      </p>
    </div>
  )
}
