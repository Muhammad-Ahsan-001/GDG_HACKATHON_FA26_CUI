import { ArrowDown, Volume2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useI18n } from '../../lib/i18n'
import { canAutoplay, playPrompt, stopVoice, useVoicePlaying } from '../../lib/voice/player'
import { MIC_SELECTOR } from './ActionBar'

const SEEN_KEY = 'awaaz.map.coachSeen'
/** Taps inside an element with this attribute neither play nor dismiss (they are voice buttons themselves). */
const KEEP_SELECTOR = '[data-awaaz-coach-keep]'
/** The SOS button: SOS is silent — a tap there stops any voice and dismisses the coach mark without a sound. */
const SOS_SELECTOR = '[data-awaaz-sos]'

/** Has this device already seen (and dismissed) the map coach mark? Storage failures count as "not seen". */
export function coachSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}

export function markCoachSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1') } catch { /* storage unavailable: shows again next visit */ }
}

/**
 * First-run coach mark, rendered over the big mic (ActionBar `micOverlay`): a pulsing amber ring, a bouncing
 * arrow and a short bubble. It never blocks the map. The `mapIntro` clip plays once — immediately with `autoPlay`
 * (straight after onboarding, when the browser allows audio), otherwise on the first tap. Any later tap dismisses it;
 * tapping the mic dismisses it at once (and opens the report as usual). Touching SOS (`data-awaaz-sos`) silences
 * it immediately. Voice buttons marked `data-awaaz-coach-keep` are left alone.
 */
export function CoachMark({ onDismiss, autoPlay }: {
  onDismiss: () => void
  /** speak straight away when the browser allows it (right after onboarding); otherwise wait for the first tap */
  autoPlay?: boolean
}) {
  const { t, lang } = useI18n()
  const playing = useVoicePlaying() === `${lang}:mapIntro`
  const heard = useRef(false)
  const dismissRef = useRef(onDismiss)
  useEffect(() => { dismissRef.current = onDismiss }, [onDismiss])

  useEffect(() => {
    if (autoPlay && !heard.current && canAutoplay()) {
      heard.current = true
      void playPrompt('mapIntro', lang)
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest(SOS_SELECTOR)) { stopVoice(); dismissRef.current(); return }
      if (target?.closest(KEEP_SELECTOR)) { heard.current = true; return } // a voice button handles itself
      if (target?.closest(MIC_SELECTOR)) { dismissRef.current(); return }
      if (!heard.current) {
        // first tap is a user gesture: now the browser lets us speak
        heard.current = true
        void playPrompt('mapIntro', lang)
        return
      }
      dismissRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [lang, autoPlay])

  return (
    <>
      <span aria-hidden className="awaaz-coach-ring pointer-events-none absolute -inset-3 rounded-full border-[5px] border-amber-400" />
      <span aria-hidden className="awaaz-coach-ring awaaz-coach-ring-2 pointer-events-none absolute -inset-3 rounded-full border-[5px] border-amber-400" />
      <div
        role="status"
        aria-live="polite"
        // physical left/translate centring is direction-agnostic
        className="pointer-events-none absolute bottom-[calc(100%+0.75rem)] left-1/2 flex w-[min(17rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center"
      >
        <div className="pointer-events-auto flex w-full items-center gap-2 rounded-2xl bg-linear-to-br from-white to-amber-50 p-2 pe-3 text-ink shadow-[0_12px_32px_-8px_rgba(180,83,9,0.35)] ring-1 ring-amber-200">
          <button
            type="button"
            data-awaaz-coach-keep=""
            onClick={() => { heard.current = true; if (playing) stopVoice(); else void playPrompt('mapIntro', lang) }}
            aria-label={t('common.listen')}
            title={t('common.listen')}
            className="relative inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-400 text-ink transition active:scale-95"
          >
            <Volume2 className="size-6" />
            {playing && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-amber-300/60" />}
          </button>
          <p className="min-w-0 text-sm leading-snug font-bold">{t('map.coachText')}</p>
        </div>
        <ArrowDown aria-hidden className="awaaz-coach-arrow mt-1 size-9 text-amber-400 drop-shadow" strokeWidth={3} />
      </div>
    </>
  )
}
