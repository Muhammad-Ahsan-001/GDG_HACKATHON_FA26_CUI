// Steps 5 + 6 — location and notification permission (each explains why, each can be skipped), and step 7 — done.
import clsx from 'clsx'
import { Bell, BellRing, CircleAlert, CircleCheck, Loader2, LocateFixed, MapPin, PartyPopper, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useGeolocation } from '../../hooks/useGeolocation'
import { api } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { enablePush, pushSupported, type PushResult } from '../../lib/push'
import { stopVoice } from '../../lib/voice/player'
import { NextButton, StepHeading, SubtleLink, usePromptEnded } from './Shell'

const AUTO_NEXT_MS = 900

function useAlive() {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  return alive
}

function Status({ tone, icon: Icon, children }: { tone: 'ok' | 'warn' | 'busy'; icon: LucideIcon; children: ReactNode }) {
  return (
    <div role="status" className={clsx(
      'flex items-center gap-3 rounded-2xl border p-3 text-start text-base font-semibold',
      tone === 'ok' && 'onb-tick border-green-200 bg-green-50 text-green-800',
      tone === 'warn' && 'border-amber-300 bg-amber-50 text-amber-900',
      tone === 'busy' && 'border-brand-100 bg-brand-50 text-brand-900',
    )}>
      <Icon className={clsx('size-7 shrink-0', tone === 'busy' && 'animate-spin')} />
      <span>{children}</span>
    </div>
  )
}

/** Big permission button: icon in a circle + label, full width. */
function AllowButton({ icon: Icon, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex min-h-20 w-full items-center justify-center gap-3 rounded-3xl bg-brand-700 px-5 text-xl font-black text-white shadow-xl shadow-brand-700/30 transition active:scale-[0.98] disabled:opacity-60">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-white/15">
        <Icon className="size-7" />
      </span>
      {label}
    </button>
  )
}

export function LocationStep({ onNext }: { onNext: () => void }) {
  const { t } = useI18n()
  const geo = useGeolocation()
  const alive = useAlive()
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  async function allow() {
    stopVoice()
    setBusy(true)
    const fix = await geo.locate()
    if (fix) {
      // nearby alerts use the saved location; a failed save is not fatal for onboarding
      try { await api.updateMyLocation(fix.lat, fix.lng) } catch { /* retried by the map / Me page later */ }
    }
    if (!alive.current) return
    setBusy(false)
    if (fix) {
      setSaved(true)
      try { navigator.vibrate?.(40) } catch { /* unsupported */ }
      setTimeout(() => { if (alive.current) onNext() }, AUTO_NEXT_MS)
    }
  }

  const failed = !busy && (geo.state === 'denied' || geo.state === 'unavailable')

  return (
    <div className="flex flex-1 flex-col gap-5">
      <StepHeading icon={MapPin} color="bg-sky-600" title={t('onboarding.locTitle')} hint={t('onboarding.locBody')} prompt="location" />
      {saved ? (
        <Status tone="ok" icon={CircleCheck}>{t('onboarding.locOk')}</Status>
      ) : busy ? (
        <Status tone="busy" icon={Loader2}>{t('onboarding.locLocating')}</Status>
      ) : failed ? (
        <Status tone="warn" icon={CircleAlert}>{geo.state === 'denied' ? t('onboarding.locDenied') : t('onboarding.locUnavailable')}</Status>
      ) : null}
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        {failed ? (
          <NextButton onClick={onNext} label={t('onboarding.continue')} ready />
        ) : (
          <AllowButton icon={LocateFixed} label={t('onboarding.locAllow')} onClick={() => { void allow() }} disabled={busy || saved} />
        )}
        {!saved && !failed && <SubtleLink onClick={() => { stopVoice(); onNext() }}>{t('onboarding.skip')}</SubtleLink>}
      </div>
    </div>
  )
}

export function NotifyStep({ onNext }: { onNext: () => void }) {
  const { t } = useI18n()
  const alive = useAlive()
  const supported = pushSupported()
  const [result, setResult] = useState<PushResult | 'working' | null>(supported ? null : 'unsupported')

  async function allow() {
    stopVoice()
    setResult('working')
    const r = await enablePush()
    if (!alive.current) return
    setResult(r)
    if (r === 'granted') {
      try { navigator.vibrate?.(40) } catch { /* unsupported */ }
      setTimeout(() => { if (alive.current) onNext() }, AUTO_NEXT_MS)
    }
  }

  const done = result === 'granted'
  const failed = result === 'denied' || result === 'unsupported' || result === 'error'

  return (
    <div className="flex flex-1 flex-col gap-5">
      <StepHeading icon={BellRing} color="bg-amber-500" title={t('onboarding.notifTitle')} hint={t('onboarding.notifBody')} prompt="notifications" />
      {done ? (
        <Status tone="ok" icon={CircleCheck}>{t('onboarding.notifOk')}</Status>
      ) : result === 'working' ? (
        <Status tone="busy" icon={Loader2}>{t('onboarding.notifWorking')}</Status>
      ) : failed ? (
        <Status tone="warn" icon={CircleAlert}>
          {result === 'denied' ? t('onboarding.notifDenied') : result === 'unsupported' ? t('onboarding.notifUnsupported') : t('onboarding.notifError')}
        </Status>
      ) : null}
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        {failed ? (
          <NextButton onClick={() => { stopVoice(); onNext() }} label={t('onboarding.continue')} ready />
        ) : (
          // if permission was already granted on this device, the tap only registers this account's token
          <AllowButton icon={Bell} label={t('onboarding.notifAllow')} onClick={() => { void allow() }} disabled={result === 'working' || done} />
        )}
        {!done && !failed && <SubtleLink onClick={() => { stopVoice(); onNext() }}>{t('onboarding.skip')}</SubtleLink>}
      </div>
    </div>
  )
}

export function DoneStep({ onFinish }: { onFinish: () => void }) {
  const { t, lang } = useI18n()
  const { profile } = useAuth()
  const name = profile?.display_name?.trim()
  // move on by itself once the "you are all set" clip has finished
  usePromptEnded(`${lang}:done`, onFinish, 1200)
  return (
    <div className="flex flex-1 flex-col gap-5">
      <StepHeading icon={PartyPopper} color="bg-green-600" title={t('onboarding.doneTitle')} prompt="done"
        hint={name ? t('onboarding.doneHello', { name }) : undefined}>
        <p className="mt-2 max-w-xs text-lg font-semibold text-ink">{t('onboarding.doneBody')}</p>
      </StepHeading>
      <div className="mt-auto pt-2">
        <NextButton onClick={() => { stopVoice(); onFinish() }} label={t('onboarding.openMap')} ready />
      </div>
    </div>
  )
}
