// Onboarding frame: back arrow, progress dots, step heading with an auto-playing voice guide, and small shared helpers.
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'
import { autoplayOnce, canAutoplay, useVoicePlaying, type VoicePromptId } from '../../lib/voice/player'
import { VoiceGuide } from '../voice/VoiceGuide'
import { ONB_STEPS, stepIndex, type OnbStep } from './progress'

export function OnbShell({ step, onBack, children }: { step: OnbStep; onBack: () => void; children: ReactNode }) {
  const { t } = useI18n()
  const idx = stepIndex(step)
  return (
    <div className="flex min-h-full flex-col bg-linear-to-b from-brand-50 to-white">
      <header className="sticky top-0 z-20 flex items-center gap-2 bg-brand-50/90 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('onboarding.back')}
          title={t('onboarding.back')}
          className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-white text-ink shadow-sm ring-1 ring-slate-200 transition active:scale-95"
        >
          <ArrowLeft className="size-7 rtl:-scale-x-100" />
        </button>
        <div className="flex flex-1 items-center justify-center gap-1.5" role="progressbar" aria-valuemin={1}
          aria-valuemax={ONB_STEPS.length} aria-valuenow={idx + 1} aria-label={t('onboarding.stepOf', { n: idx + 1, total: ONB_STEPS.length })}>
          {ONB_STEPS.map((s, i) => (
            <span
              key={s}
              className={clsx(
                'h-2.5 rounded-full transition-all duration-300',
                i === idx ? 'w-7 bg-brand-700' : i < idx ? 'w-2.5 bg-brand-500' : 'w-2.5 bg-slate-300',
              )}
            />
          ))}
        </div>
        {/* keeps the dots centred opposite the back button */}
        <span className="size-14 shrink-0" aria-hidden />
      </header>
      <main key={step} className="onb-step-in mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
        {children}
      </main>
    </div>
  )
}

/** Big icon + title + hint + the "Listen" guide (auto-plays once; if the browser blocked it, plays on the first tap). */
export function StepHeading({
  icon: Icon, color = 'bg-brand-700', title, hint, prompt, autoPlay = true, children,
}: {
  icon: LucideIcon; color?: string; title: ReactNode; hint?: ReactNode; prompt: VoicePromptId; autoPlay?: boolean; children?: ReactNode
}) {
  useAutoplayOnFirstTap(autoPlay ? prompt : null)
  return (
    <div className="flex flex-col items-center gap-2 pt-2 text-center">
      <span className={clsx('inline-flex size-20 items-center justify-center rounded-3xl text-white shadow-lg', color)}>
        <Icon className="size-10" />
      </span>
      <h1 className="text-2xl font-black leading-tight text-ink">{title}</h1>
      {hint && <p className="text-base text-slate-600">{hint}</p>}
      <VoiceGuide prompt={prompt} autoPlay={autoPlay} size={48} />
      {children}
    </div>
  )
}

/** Autoplay is blocked until the first user gesture (e.g. after a reload): play the step's prompt on the first tap. */
export function useAutoplayOnFirstTap(prompt: VoicePromptId | null) {
  const { lang } = useI18n()
  useEffect(() => {
    if (!prompt || canAutoplay()) return
    const onTap = () => autoplayOnce(prompt, lang)
    window.addEventListener('click', onTap, { capture: true, once: true })
    return () => window.removeEventListener('click', onTap, { capture: true })
  }, [prompt, lang])
}

/**
 * Calls `onEnded` when the voice clip `key` (e.g. "ur:welcome") finishes on its own — not when it is
 * interrupted by another clip. Used to move on automatically after a clip.
 */
export function usePromptEnded(key: string | null, onEnded: () => void, delayMs = 500) {
  const playing = useVoicePlaying()
  const was = useRef(false)
  const cb = useRef(onEnded)
  useEffect(() => { cb.current = onEnded })
  useEffect(() => {
    if (!key) { was.current = false; return }
    if (playing === key) { was.current = true; return }
    if (playing !== null) { was.current = false; return }
    if (!was.current) return
    was.current = false
    const id = setTimeout(() => cb.current(), delayMs)
    return () => clearTimeout(id)
  }, [playing, key, delayMs])
}

/** Large round "next" arrow (green) — the universal "go on" for users who cannot read. */
export function NextButton({ onClick, disabled, ready, label, className }: {
  onClick: () => void; disabled?: boolean; ready?: boolean; label?: string; className?: string
}) {
  const { t } = useI18n()
  const text = label ?? t('onboarding.next')
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={text}
      className={clsx(
        'inline-flex min-h-16 w-full items-center justify-center gap-3 rounded-full bg-green-600 px-6 text-xl font-black text-white shadow-lg shadow-green-600/30 transition active:scale-[0.98] disabled:opacity-40',
        ready && !disabled && 'onb-ready',
        className,
      )}
    >
      {text}
      <ArrowRight className="size-8 rtl:-scale-x-100" />
    </button>
  )
}

/** Small text link under the main action (skip, type instead, change number…). */
export function SubtleLink({ onClick, icon: Icon, children, className }: {
  onClick: () => void; icon?: LucideIcon; children: ReactNode; className?: string
}) {
  return (
    <button type="button" onClick={onClick}
      className={clsx('inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-4 text-base font-semibold text-slate-600 hover:bg-slate-100 hover:text-ink', className)}>
      {Icon && <Icon className="size-5" />}
      {children}
    </button>
  )
}
