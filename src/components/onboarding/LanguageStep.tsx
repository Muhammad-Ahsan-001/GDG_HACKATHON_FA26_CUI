// Step 1 — language: two huge script buttons. Tapping sets the language and plays the welcome clip in it;
// when the clip ends we move on by ourselves (the green arrow skips the wait).
import clsx from 'clsx'
import { Check, Languages } from 'lucide-react'
import { useEffect, useState } from 'react'
import { translate, useI18n } from '../../lib/i18n'
import type { Lang } from '../../lib/types'
import { canAutoplay, playPrompt, playSequence, stopVoice } from '../../lib/voice/player'
import { VoiceGuide } from '../voice/VoiceGuide'
import { NextButton, usePromptEnded } from './Shell'

let introPlayed = false

export function LanguageStep({ onNext }: { onNext: () => void }) {
  const { setLang, t } = useI18n()
  const [chosen, setChosen] = useState<Lang | null>(null)

  // We do not know the user's language yet: ask in both (once per page session; needs a prior tap, e.g. Landing "Start").
  useEffect(() => {
    if (introPlayed || !canAutoplay()) return
    introPlayed = true
    void playSequence([{ id: 'chooseLanguage', lang: 'ur' }, { id: 'chooseLanguage', lang: 'en' }])
  }, [])

  usePromptEnded(chosen ? `${chosen}:welcome` : null, onNext, 600)

  function choose(l: Lang) {
    introPlayed = true
    setLang(l)
    setChosen(l)
    try { navigator.vibrate?.(20) } catch { /* unsupported */ }
    stopVoice()
    void playPrompt('welcome', l)
  }

  const option = (l: Lang) => {
    const selected = chosen === l
    const isUr = l === 'ur'
    return (
      <button
        key={l}
        type="button"
        onClick={() => choose(l)}
        aria-pressed={selected}
        lang={l}
        className={clsx(
          'relative flex min-h-32 w-full flex-col items-center justify-center rounded-[2rem] border-4 bg-white px-4 py-3 shadow-md transition active:scale-[0.98]',
          selected ? 'border-brand-700 bg-brand-50 shadow-xl' : 'border-transparent ring-1 ring-slate-200',
        )}
      >
        <span dir={isUr ? 'rtl' : 'ltr'} className={clsx(
          'block font-black text-ink',
          isUr ? 'font-urdu text-5xl leading-[1.9]' : 'font-latin text-5xl leading-tight',
        )}>
          {isUr ? 'اردو' : 'English'}
        </span>
        <span dir={isUr ? 'ltr' : 'rtl'} lang={isUr ? 'en' : 'ur'}
          className={clsx('block text-base text-slate-500', isUr ? 'font-latin' : 'font-urdu leading-[1.9]')}>
          {isUr ? 'Urdu' : 'انگریزی'}
        </span>
        {selected && (
          <span className="onb-tick absolute end-4 top-4 inline-flex size-10 items-center justify-center rounded-full bg-brand-700 text-white">
            <Check className="size-6" />
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <span className="inline-flex size-20 items-center justify-center rounded-3xl bg-brand-700 text-white shadow-lg">
          <Languages className="size-10" />
        </span>
        {/* bilingual on purpose: the user has not chosen yet */}
        <h1 className="text-2xl font-black leading-tight">
          <span lang="ur" dir="rtl" className="font-urdu block leading-[1.9]">{translate('ur', 'onboarding.langTitle')}</span>
          <span lang="en" dir="ltr" className="font-latin block">{translate('en', 'onboarding.langTitle')}</span>
        </h1>
        <VoiceGuide prompt="chooseLanguage" size={48} />
      </div>

      <div className="flex flex-col gap-4">
        {option('ur')}
        {option('en')}
      </div>

      <p className="text-center text-sm text-slate-500">{t('onboarding.langHint')}</p>

      <div className="mt-auto pt-2">
        {/* enabled before a choice too: a returning user already has a language */}
        <NextButton onClick={() => { stopVoice(); onNext() }} ready={Boolean(chosen)} />
      </div>
    </div>
  )
}
