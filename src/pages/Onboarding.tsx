// Illiterate-first onboarding (docs/CONTRACT-1B.md "Frontend flows → Onboarding"):
// 1 language → 2 phone → 3 mock SMS (+ anonymous sign-in) → 4 voice profile → 5 location → 6 notifications → 7 done → /map.
// No session is needed to start; progress survives a reload (sessionStorage).
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LanguageStep } from '../components/onboarding/LanguageStep'
import '../components/onboarding/onboarding.css'
import { DoneStep, LocationStep, NotifyStep } from '../components/onboarding/PermissionSteps'
import { PhoneStep } from '../components/onboarding/PhoneStep'
import { ProfileStep } from '../components/onboarding/ProfileStep'
import {
  clearProgress, EMPTY_PROGRESS, isValidPhone, loadProgress, markOnboardingSeen, ONB_STEPS, saveProgress, stepIndex,
  type OnbProgress, type OnbStep, type ProfileDraft,
} from '../components/onboarding/progress'
import { OnbShell } from '../components/onboarding/Shell'
import { SmsStep } from '../components/onboarding/SmsStep'
import { Spinner } from '../components/ui'
import { homeFor, useAuth } from '../hooks/useAuth'
import { stopVoice } from '../lib/voice/player'

/** Steps that need a signed-in user (the SMS step signs in anonymously). */
const NEEDS_SESSION = stepIndex('profile')

export default function Onboarding() {
  const { session, profile, loading, isOnboarded } = useAuth()
  const nav = useNavigate()
  const [resumed] = useState(() => loadProgress())
  const [p, setP] = useState<OnbProgress>(() => resumed ?? EMPTY_PROGRESS)
  const [open, setOpen] = useState(false)
  const uid = session?.user.id ?? null

  useEffect(() => { saveProgress(p) }, [p])
  useEffect(() => () => stopVoice(), [])
  // RequireAuth redirects a not-yet-onboarded citizen here only once
  useEffect(() => { if (uid) markOnboardingSeen(uid) }, [uid])

  // One-time gate once auth has settled: organisations / admins have no citizen onboarding, and an already
  // onboarded citizen who did not start a flow in this tab goes straight to the map.
  useEffect(() => {
    if (open || loading) return
    if (uid && (!profile || profile.id !== uid)) {
      const id = setTimeout(() => setOpen(true), 2500) // profile slow / unreadable: never block the flow
      return () => clearTimeout(id)
    }
    if (uid && profile) {
      if (profile.role !== 'citizen') { clearProgress(); nav(homeFor(profile.role), { replace: true }); return }
      if (isOnboarded && !resumed) { nav('/map', { replace: true }); return }
    }
    setP((prev) => {
      let step = prev.step
      if (!uid && stepIndex(step) >= NEEDS_SESSION) step = 'sms'
      if (step === 'sms' && !isValidPhone(prev.phone)) step = 'phone'
      return step === prev.step ? prev : { ...prev, step, saved: uid ? prev.saved : false }
    })
    setOpen(true)
  }, [open, loading, uid, profile, isOnboarded, resumed, nav])

  const go = useCallback((step: OnbStep) => {
    stopVoice()
    setP((prev) => ({ ...prev, step }))
    try { window.scrollTo({ top: 0 }) } catch { /* old browsers */ }
  }, [])

  const back = useCallback(() => {
    const i = stepIndex(p.step)
    if (i <= 0) { stopVoice(); nav('/'); return }
    // the number is already verified: from the profile go back to the number itself
    go(p.step === 'profile' ? 'phone' : ONB_STEPS[i - 1])
  }, [p.step, go, nav])

  const setPhone = useCallback((phone: string) => setP((prev) => ({ ...prev, phone })), [])

  const onSaved = useCallback((draft: ProfileDraft) => {
    stopVoice()
    setP((prev) => ({ ...prev, draft, saved: true, step: 'location' }))
  }, [])

  const finish = useCallback(() => {
    stopVoice()
    clearProgress()
    // MapPage may show its first-run coach mark on the mic (mapIntro) for this navigation
    nav('/map', { replace: true, state: { firstRun: true } })
  }, [nav])

  if (!open) {
    return <div className="flex h-full items-center justify-center text-brand-700"><Spinner className="size-10" /></div>
  }

  return (
    <OnbShell step={p.step} onBack={back}>
      {p.step === 'language' && <LanguageStep onNext={() => go('phone')} />}
      {p.step === 'phone' && <PhoneStep phone={p.phone} onChange={setPhone} onNext={() => go('sms')} />}
      {p.step === 'sms' && <SmsStep phone={p.phone} onVerified={() => go('profile')} onChangeNumber={() => go('phone')} />}
      {p.step === 'profile' && <ProfileStep phone={p.phone} initialDraft={p.saved ? p.draft : null} onSaved={onSaved} />}
      {p.step === 'location' && <LocationStep onNext={() => go('notify')} />}
      {p.step === 'notify' && <NotifyStep onNext={() => go('done')} />}
      {p.step === 'done' && <DoneStep onFinish={finish} />}
    </OnbShell>
  )
}
