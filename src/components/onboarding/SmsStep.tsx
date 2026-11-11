// Step 3 — mock SMS verification. No SMS is ever sent: a realistic notification slides down with a random
// 4-digit code; tapping it types the code into the boxes and verifies. Then we sign in anonymously (if needed)
// and keep the phone on the profile (best effort; complete_onboarding saves it for sure).
import clsx from 'clsx'
import { ArrowUp, CircleCheck, Loader2, MessageSquareText, Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useI18n } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { playPrompt, stopVoice } from '../../lib/voice/player'
import { ErrorBanner } from '../auth/parts'
import { formatE164, randomCode, toE164 } from './progress'
import { StepHeading, SubtleLink } from './Shell'

const SMS_DELAY_MS = 1200
const FILL_STEP_MS = 170

type Status = 'waiting' | 'filling' | 'verifying' | 'ok' | 'wrong'

export function SmsStep({ phone, onVerified, onChangeNumber }: {
  phone: string
  onVerified: () => void
  onChangeNumber: () => void
}) {
  const { t, lang } = useI18n()
  const { session, signInAnonymously } = useAuth()
  const [code, setCode] = useState(randomCode)
  const [entered, setEntered] = useState('')
  const [sms, setSms] = useState<'hidden' | 'shown' | 'leaving'>('hidden')
  const [status, setStatus] = useState<Status>('waiting')
  const [shake, setShake] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const alive = useRef(true)
  const hasSession = Boolean(session)

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms))
  }, [])
  const clearTimers = useCallback(() => { timers.current.forEach(clearTimeout); timers.current = [] }, [])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; clearTimers() }
  }, [clearTimers])

  // the "SMS" arrives ~1.2 s after the step opens (and after every resend)
  useEffect(() => {
    setSms('hidden')
    const id = setTimeout(() => {
      setSms('shown')
      try { navigator.vibrate?.([70, 50, 70]) } catch { /* unsupported */ }
    }, SMS_DELAY_MS)
    return () => clearTimeout(id)
  }, [code])

  const verify = useCallback(async (value: string) => {
    if (value !== code) {
      setStatus('wrong')
      setShake((n) => n + 1)
      try { navigator.vibrate?.([40, 60, 40]) } catch { /* unsupported */ }
      void playPrompt('codeWrong', lang)
      later(() => { if (alive.current) { setEntered(''); setStatus('waiting') } }, 700)
      return
    }
    setStatus('verifying')
    setError(null)
    try {
      if (!hasSession) await signInAnonymously()
      // best effort: keep the number even if the user stops before the profile step
      const e164 = toE164(phone)
      const { data } = await supabase.auth.getSession()
      const uid = data.session?.user.id
      if (uid && e164) void supabase.from('profiles').update({ phone: e164 }).eq('id', uid).then(() => undefined, () => undefined)
      if (!alive.current) return
      setStatus('ok')
      stopVoice()
      try { navigator.vibrate?.(40) } catch { /* unsupported */ }
      later(() => { if (alive.current) onVerified() }, 800)
    } catch (e) {
      if (!alive.current) return
      setError(e)
      setStatus('waiting')
      setEntered('')
      void playPrompt('tryAgain', lang)
    }
  }, [code, hasSession, signInAnonymously, phone, lang, later, onVerified])

  // tap on the notification: it slides away and the digits drop into the boxes one by one
  function fillFromSms() {
    if (status === 'verifying' || status === 'ok' || status === 'filling') return
    clearTimers()
    stopVoice()
    setSms('leaving')
    later(() => { if (alive.current) setSms((v) => (v === 'leaving' ? 'hidden' : v)) }, 450) // reduced motion: no animationend
    setStatus('filling')
    setEntered('')
    code.split('').forEach((_, i) => {
      later(() => { if (alive.current) setEntered(code.slice(0, i + 1)) }, 260 + i * FILL_STEP_MS)
    })
    later(() => { if (alive.current) void verify(code) }, 260 + code.length * FILL_STEP_MS + 150)
  }

  function onType(v: string) {
    if (status === 'verifying' || status === 'ok' || status === 'filling') return
    const digits = v.replace(/\D/g, '').slice(0, 4)
    setEntered(digits)
    if (status === 'wrong') setStatus('waiting')
    if (digits.length === 4) void verify(digits)
  }

  function resend() {
    clearTimers()
    setEntered('')
    setStatus('waiting')
    setError(null)
    setCode(randomCode())
  }

  const busy = status === 'verifying' || status === 'filling' || status === 'ok'

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* the fake heads-up notification */}
      {sms !== 'hidden' && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={fillFromSms}
            onAnimationEnd={() => { if (sms === 'leaving') setSms('hidden') }}
            aria-label={t('onboarding.smsAria', { code })}
            className={clsx(
              'w-full max-w-md overflow-hidden rounded-3xl bg-white text-start shadow-2xl ring-1 ring-black/10',
              sms === 'shown' ? 'onb-sms-in pointer-events-auto' : 'onb-sms-out pointer-events-none',
            )}
          >
            <span className={clsx('block p-3', sms === 'shown' && 'onb-sms-nudge')}>
              <span className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-green-600 text-white">
                  <MessageSquareText className="size-3.5" />
                </span>
                {t('onboarding.smsApp')}
                <span aria-hidden>·</span>
                {t('onboarding.smsNow')}
              </span>
              <span className="mt-1.5 flex items-start gap-3">
                <span className="font-latin inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-700 text-lg font-black text-white">A</span>
                <span className="min-w-0 flex-1">
                  <span className="font-latin block text-base font-bold text-ink" dir="ltr">{t('onboarding.smsSender')}</span>
                  <span className="block text-base text-slate-700">
                    {t('onboarding.smsBody', { code })}
                  </span>
                </span>
                <span dir="ltr" className="font-latin shrink-0 self-center rounded-xl bg-brand-50 px-2.5 py-1 text-2xl font-black tracking-widest text-brand-900">{code}</span>
              </span>
            </span>
            <span className="block bg-amber-100 px-3 py-1.5 text-center text-xs font-bold text-amber-900">
              {t('onboarding.smsDemoLabel')}
            </span>
          </button>
        </div>
      )}

      <StepHeading icon={MessageSquareText} title={t('onboarding.smsTitle')} prompt="sms"
        hint={<>
          {t('onboarding.smsSentTo')}{' '}
          <span dir="ltr" className="font-latin whitespace-nowrap font-bold text-ink">{formatE164(phone)}</span>
        </>}
      />

      {/* code boxes with one invisible input over them for people who prefer to type */}
      <div key={shake} className={clsx('relative mx-auto', status === 'wrong' && 'onb-shake')} onClick={() => inputRef.current?.focus()}>
        <div dir="ltr" className="flex gap-3">
          {[0, 1, 2, 3].map((i) => {
            const ch = entered[i]
            return (
              <span key={i} className={clsx(
                'font-latin inline-flex size-16 items-center justify-center rounded-2xl border-2 bg-white text-4xl font-black shadow-sm',
                status === 'ok' ? 'border-green-500 text-green-700'
                  : status === 'wrong' ? 'border-red-400 text-red-700'
                    : ch ? 'border-brand-600 text-ink' : i === entered.length ? 'border-brand-400' : 'border-slate-200',
              )}>
                {ch && <span key={`${i}-${ch}-${entered.length}`} className="onb-pop">{ch}</span>}
              </span>
            )
          })}
        </div>
        <input
          ref={inputRef}
          value={entered}
          onChange={(e) => onType(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={4}
          disabled={busy}
          aria-label={t('onboarding.codeAria')}
          dir="ltr"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>

      <div className="flex min-h-14 items-center justify-center" aria-live="polite">
        {status === 'verifying' || status === 'filling' ? (
          <span className="inline-flex items-center gap-2 text-lg font-bold text-brand-700">
            <Loader2 className="size-6 animate-spin" /> {t('onboarding.verifying')}
          </span>
        ) : status === 'ok' ? (
          <span className="onb-tick inline-flex items-center gap-2 text-lg font-bold text-green-700">
            <CircleCheck className="size-8" /> {t('onboarding.verified')}
          </span>
        ) : status === 'wrong' ? (
          <span role="alert" className="text-base font-semibold text-red-700">{t('onboarding.codeWrong')}</span>
        ) : sms === 'shown' ? (
          <span className="inline-flex items-center gap-2 text-lg font-bold text-brand-800">
            <ArrowUp className="size-7 animate-bounce" /> {t('onboarding.smsTapHint')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 text-base text-slate-500">
            <Loader2 className="size-5 animate-spin" /> {t('onboarding.smsWaiting')}
          </span>
        )}
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="mt-auto flex flex-wrap items-center justify-center gap-1 pt-2">
        <SubtleLink icon={RotateCcw} onClick={resend}>{t('onboarding.resend')}</SubtleLink>
        <SubtleLink icon={Pencil} onClick={() => { clearTimers(); onChangeNumber() }}>{t('onboarding.changeNumber')}</SubtleLink>
      </div>
      <p className="text-center text-xs text-slate-500">{t('onboarding.simulatedNote')}</p>
    </div>
  )
}
