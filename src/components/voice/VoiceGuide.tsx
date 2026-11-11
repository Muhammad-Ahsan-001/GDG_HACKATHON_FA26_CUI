import clsx from 'clsx'
import { Volume2 } from 'lucide-react'
import { useEffect } from 'react'
import { useI18n } from '../../lib/i18n'
import { autoplayOnce, playPrompt, stopVoice, useVoicePlaying, type VoicePromptId } from '../../lib/voice/player'

/**
 * "Listen" button that speaks what the current screen is asking, in the user's language
 * (pre-recorded Urdu / English clips). Illiterate users can tap it anywhere they are unsure.
 *   <VoiceGuide prompt="reportVoice" autoPlay />   — autoPlay = once per session, after the first tap on the page
 */
export function VoiceGuide({
  prompt, autoPlay, size = 48, className, label = true,
}: { prompt: VoicePromptId; autoPlay?: boolean; size?: number; className?: string; label?: boolean }) {
  const { lang, t } = useI18n()
  const playing = useVoicePlaying() === `${lang}:${prompt}`

  useEffect(() => {
    if (autoPlay) autoplayOnce(prompt, lang)
  }, [autoPlay, prompt, lang])

  return (
    <button
      type="button"
      onClick={() => (playing ? stopVoice() : void playPrompt(prompt, lang))}
      aria-label={t('common.listen')}
      title={t('common.listen')}
      className={clsx(
        'inline-flex shrink-0 items-center gap-2 rounded-full bg-amber-100 pe-3 font-semibold text-amber-900 shadow-sm ring-1 ring-amber-300 transition active:scale-95',
        !label && 'pe-0',
        className,
      )}
      style={{ minHeight: size }}
    >
      <span
        className={clsx('relative inline-flex items-center justify-center rounded-full bg-amber-400 text-white', playing && 'animate-pulse')}
        style={{ width: size, height: size }}
      >
        <Volume2 style={{ width: size * 0.5, height: size * 0.5 }} />
        {playing && <span className="absolute inset-0 animate-ping rounded-full bg-amber-400/50" />}
      </span>
      {label && <span className="text-sm">{t('common.listen')}</span>}
    </button>
  )
}
