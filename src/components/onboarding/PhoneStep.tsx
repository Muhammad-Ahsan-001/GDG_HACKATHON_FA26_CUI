// Step 2 — phone number on a big keypad (+92 prefix shown, Pakistani mobile format 03xx xxxxxxx).
import clsx from 'clsx'
import { Smartphone, Sparkles } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { playPrompt, stopVoice } from '../../lib/voice/player'
import { Keypad } from './Keypad'
import { DEMO_PHONE, formatPhone, isValidPhone, phoneMaxLength } from './progress'
import { NextButton, StepHeading } from './Shell'

export function PhoneStep({ phone, onChange, onNext }: {
  phone: string
  onChange: (digits: string) => void
  onNext: () => void
}) {
  const { t, lang } = useI18n()
  const [invalid, setInvalid] = useState(false)
  const [shake, setShake] = useState(0)
  const valid = isValidPhone(phone)

  const add = useCallback((d: string) => {
    setInvalid(false)
    if (phone.length >= phoneMaxLength(phone)) return
    onChange(phone + d)
  }, [phone, onChange])
  const back = useCallback(() => { setInvalid(false); onChange(phone.slice(0, -1)) }, [phone, onChange])
  const clear = useCallback(() => { setInvalid(false); onChange('') }, [onChange])

  function fillDemo() {
    setInvalid(false)
    onChange(DEMO_PHONE)
    try { navigator.vibrate?.(20) } catch { /* unsupported */ }
  }

  function next() {
    if (!valid) {
      setInvalid(true)
      setShake((n) => n + 1)
      try { navigator.vibrate?.([40, 60, 40]) } catch { /* unsupported */ }
      void playPrompt('phoneInvalid', lang)
      return
    }
    stopVoice()
    onNext()
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <StepHeading icon={Smartphone} title={t('onboarding.phoneTitle')} hint={t('onboarding.phoneHint')} prompt="phone" />

      {/* number display */}
      <div
        key={shake}
        dir="ltr"
        aria-live="polite"
        aria-label={t('onboarding.phoneAria')}
        className={clsx(
          'flex min-h-18 items-center gap-3 rounded-3xl border-2 bg-white px-3 py-2 shadow-sm',
          invalid ? 'onb-shake border-red-400' : valid ? 'border-green-500' : 'border-slate-200',
        )}
      >
        <span className="font-latin inline-flex shrink-0 items-center gap-1.5 rounded-2xl bg-green-700 px-3 py-2 text-lg font-bold text-white">
          {/* Pakistan flag colours, no emoji font needed */}
          <span aria-hidden className="inline-flex h-4 w-6 overflow-hidden rounded-sm">
            <span className="w-1.5 bg-white" /><span className="flex-1 bg-green-800" />
          </span>
          +92
        </span>
        <span className={clsx('font-latin min-w-0 flex-1 truncate text-3xl font-bold tracking-wide', phone ? 'text-ink' : 'text-slate-300')}>
          {phone ? formatPhone(phone) : t('onboarding.phonePlaceholder')}
          <span aria-hidden className="ms-0.5 inline-block h-8 w-0.5 translate-y-1 animate-pulse bg-brand-600" />
        </span>
      </div>
      {invalid && <p role="alert" className="-mt-2 text-center text-sm font-semibold text-red-700">{t('onboarding.phoneInvalid')}</p>}

      <button
        type="button"
        onClick={fillDemo}
        className="inline-flex min-h-14 items-center justify-center gap-2 self-center rounded-full bg-amber-100 px-5 text-base font-bold text-amber-900 ring-1 ring-amber-300 transition active:scale-95"
      >
        <Sparkles className="size-5" />
        {t('onboarding.useDemoNumber')}
        <span dir="ltr" className="font-latin text-sm font-semibold opacity-80">0300 1234567</span>
      </button>

      <Keypad onDigit={add} onBackspace={back} onClear={clear} />

      <div className="mt-auto pt-1">
        <NextButton onClick={next} ready={valid} />
        <p className="mt-2 text-center text-xs text-slate-500">{t('onboarding.phonePrivacy')}</p>
      </div>
    </div>
  )
}
