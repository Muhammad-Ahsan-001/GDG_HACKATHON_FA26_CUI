// Step 4 — voice profile: ONE spoken question ("tell us your name and your area") → voice-profile Edge Function
// extracts name + area → read-back card (icons first) with the confirmation clip → green ✓ saves via
// complete_onboarding, red ✗ asks again. Silence / too-short takes are caught on the phone before uploading.
import clsx from 'clsx'
import {
  Check, CircleAlert, Keyboard, Languages, Loader2, MapPin, Mic, Pencil, Sparkles, Square, UserRound, Volume2, X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { isRecordingSupported, useRecorder } from '../../hooks/useRecorder'
import { api, type VoiceProfileResponse } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { newClientId, uploadAudio } from '../../lib/media'
import type { Lang } from '../../lib/types'
import { playPrompt, playUrl, stopVoice, useVoicePlaying, type VoicePromptId } from '../../lib/voice/player'
import { ErrorBanner, TextField } from '../auth/parts'
import { AiLabel } from '../ui'
import { toE164, type ProfileDraft } from './progress'
import { StepHeading, SubtleLink } from './Shell'

/** Client-side silence detection on the recorder's 0..1 level meter (same idea as the report flow). */
const SILENT_PEAK = 0.18      // loudest moment below this = nobody spoke
const VOICED_LEVEL = 0.22     // frames above this count as voice
const MIN_TAKE_MS = 1000
const MIN_VOICED_MS = 700
const MAX_TAKE_MS = 20_000
const CONFIRM_KEY = 'onb:confirm'

type Phase = 'ask' | 'checking' | 'confirm' | 'typing'
type Msg = 'noSpeech' | 'tooShort' | 'missing' | 'micDenied' | 'micUnsupported' | 'failed'

const LANG_LABEL: Record<Lang, string> = { ur: 'اردو', en: 'English' }

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function clean(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function ProfileStep({ phone, initialDraft, onSaved }: {
  phone: string
  initialDraft: ProfileDraft | null
  onSaved: (d: ProfileDraft) => void
}) {
  const { t, lang, setLang } = useI18n()
  const { refreshProfile } = useAuth()
  const rec = useRecorder({ maxMs: MAX_TAKE_MS })
  const canRecord = isRecordingSupported()
  const [phase, setPhase] = useState<Phase>(() => (initialDraft ? 'confirm' : canRecord ? 'ask' : 'typing'))
  const [msg, setMsg] = useState<Msg | null>(() => (!initialDraft && !canRecord ? 'micUnsupported' : null))
  const [stage, setStage] = useState<'upload' | 'ai'>('upload')
  const [draft, setDraft] = useState<ProfileDraft | null>(initialDraft)
  const [heard, setHeard] = useState('')
  const [form, setForm] = useState({
    name: initialDraft?.display_name ?? '', area: initialDraft?.home_area ?? '', language: initialDraft?.language ?? lang,
  })
  const [formErr, setFormErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null)
  const readToken = useRef(0)
  const alive = useRef(true)
  const stats = useRef({ peak: 0, voicedMs: 0, last: 0 })
  const playingConfirm = useVoicePlaying() === CONFIRM_KEY

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; readToken.current++ }
  }, [])

  const say = (id: VoicePromptId) => { void playPrompt(id, lang) }

  // peak level + voiced time of the current take
  useEffect(() => {
    if (rec.state !== 'recording') return
    const s = stats.current
    const now = performance.now()
    if (rec.level > s.peak) s.peak = rec.level
    if (s.last && rec.level >= VOICED_LEVEL) s.voicedMs += Math.min(250, now - s.last)
    s.last = now
  }, [rec.level, rec.state])

  // recorder outcomes (tap-to-stop and the auto-stop at MAX_TAKE_MS both land here)
  useEffect(() => {
    if (rec.state === 'stopped' && rec.blob) {
      const blob = rec.blob
      const dur = rec.durationMs
      rec.reset()
      if (phase === 'ask') void handleTake(blob, dur)
    } else if (rec.state === 'denied') {
      rec.reset() // so a second refusal is noticed again
      setMsg('micDenied')
      setPhase('typing')
      say('micDenied')
    } else if (rec.state === 'error') {
      rec.reset()
      setMsg('failed')
      say('tryAgain')
    } else if (rec.state === 'unsupported' && phase === 'ask') {
      rec.reset() // e.g. no microphone found: back to idle so "speak instead" can try again
      setMsg('micUnsupported')
      setPhase('typing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to recorder transitions only
  }, [rec.state, rec.blob])

  function toggleMic() {
    setError(null)
    if (rec.state === 'recording') { void rec.stop(); return }
    readToken.current++
    stopVoice() // never record our own prompt
    setMsg(null)
    stats.current = { peak: 0, voicedMs: 0, last: 0 }
    try { navigator.vibrate?.(25) } catch { /* unsupported */ }
    void rec.start()
  }

  async function handleTake(blob: Blob, durationMs: number) {
    const s = stats.current
    // peak === 0 means the level meter is unavailable on this browser: let the server decide
    if (s.peak > 0 && s.peak < SILENT_PEAK) { setMsg('noSpeech'); say('noSpeech'); return }
    if (durationMs < MIN_TAKE_MS || (s.peak > 0 && s.voicedMs < MIN_VOICED_MS)) { setMsg('tooShort'); say('profileRetry'); return }
    setPhase('checking')
    setStage('upload')
    setError(null)
    try {
      const path = await uploadAudio(blob, blob.type || 'audio/webm', `profile-${newClientId()}`)
      if (!alive.current) return
      setStage('ai')
      const res = await api.voiceProfile({ audio_path: path, ui_language: lang })
      if (!alive.current) return
      onResult(res)
    } catch (e) {
      if (!alive.current) return
      setPhase('ask')
      setError(e)
      setMsg('failed')
      say('tryAgain')
    }
  }

  function onResult(res: VoiceProfileResponse) {
    setHeard(clean(res.transcript))
    if (res.no_speech) { setPhase('ask'); setMsg('noSpeech'); say('noSpeech'); return }
    const name = clean(res.profile.display_name)
    const area = clean(res.profile.home_area)
    if (!name && !area) { setPhase('ask'); setMsg('missing'); say('profileRetry'); return }
    const d: ProfileDraft = { display_name: name, home_area: area, language: lang }
    setDraft(d)
    setForm({ name, area, language: lang })
    setMsg(null)
    setConfirmUrl(res.confirm_audio_url ?? null)
    setPhase('confirm')
    try { navigator.vibrate?.(30) } catch { /* unsupported */ }
    void readBack(res)
  }

  /** Read the extracted details back (server clip, else on-demand TTS), then the "green = yes, red = again" prompt. */
  async function readBack(res: VoiceProfileResponse) {
    const my = ++readToken.current
    let url = res.confirm_audio_url ?? null
    if (!url) {
      const text = lang === 'ur' ? res.confirm.ur || res.confirm.en : res.confirm.en || res.confirm.ur
      if (text) {
        try { url = (await api.tts(text.slice(0, 400), lang)).url } catch { url = null }
        if (alive.current && url) setConfirmUrl(url)
      }
    }
    if (my !== readToken.current || !alive.current) return
    if (url) await playUrl(url, CONFIRM_KEY)
    if (my !== readToken.current || !alive.current) return
    await playPrompt('profileConfirm', lang)
  }

  function retry() {
    readToken.current++
    stopVoice()
    setDraft(null)
    setHeard('')
    setError(null)
    setMsg(null)
    setConfirmUrl(null)
    setPhase(canRecord ? 'ask' : 'typing')
    if (canRecord) say('profileAsk')
  }

  function openForm(withMsg: Msg | null = null) {
    readToken.current++
    stopVoice()
    if (rec.state === 'recording') rec.reset()
    setForm({ name: draft?.display_name ?? form.name, area: draft?.home_area ?? form.area, language: draft?.language ?? form.language })
    setFormErr(null)
    setMsg(withMsg)
    setPhase('typing')
  }

  async function save(d: ProfileDraft) {
    const name = clean(d.display_name)
    const area = clean(d.home_area)
    if (!name || !area) { openForm('missing'); return }
    readToken.current++
    stopVoice()
    setSaving(true)
    setError(null)
    try {
      await api.completeOnboarding({ display_name: name, home_area: area, language: d.language, phone: toE164(phone) })
      if (d.language !== lang) setLang(d.language)
      await refreshProfile()
      if (!alive.current) return
      try { navigator.vibrate?.(40) } catch { /* unsupported */ }
      onSaved({ display_name: name, home_area: area, language: d.language })
    } catch (e) {
      if (!alive.current) return
      setError(e)
      say('tryAgain')
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  function submitForm(e: FormEvent) {
    e.preventDefault()
    const name = clean(form.name)
    const area = clean(form.area)
    if (!name) { setFormErr('needName'); return }
    if (!area) { setFormErr('needArea'); return }
    setFormErr(null)
    const d: ProfileDraft = { display_name: name, home_area: area, language: form.language }
    setDraft(d)
    void save(d)
  }

  // ---------------------------------------------------------------- views

  const notice = msg && (
    <div role="alert" className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-start text-amber-900">
      <CircleAlert className="mt-0.5 size-6 shrink-0 text-amber-600" />
      <span className="text-base font-semibold">{t(`onboarding.${msg}`)}</span>
    </div>
  )

  if (phase === 'checking') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center" aria-live="polite">
        <span className="relative inline-flex size-36 items-center justify-center">
          <span className="onb-ring absolute inset-0 rounded-full bg-violet-400/30" />
          <span className="onb-ring onb-ring-delay absolute inset-0 rounded-full bg-violet-400/30" />
          <span className="relative inline-flex size-28 items-center justify-center rounded-full bg-violet-600 text-white shadow-xl">
            {stage === 'upload' ? <Loader2 className="size-14 animate-spin" /> : <Sparkles className="size-14 animate-pulse" />}
          </span>
        </span>
        <p className="text-2xl font-black text-ink">{stage === 'upload' ? t('onboarding.uploading') : t('onboarding.thinking')}</p>
      </div>
    )
  }

  if (phase === 'confirm' && draft) {
    const otherLang: Lang = draft.language === 'ur' ? 'en' : 'ur'
    return (
      <div className="flex flex-1 flex-col gap-4">
        <StepHeading icon={UserRound} title={t('onboarding.confirmTitle')} prompt="profileConfirm" autoPlay={false} />

        <section className="rounded-3xl bg-white p-4 shadow-md ring-1 ring-slate-200">
          <div className="mb-2 flex items-center justify-between gap-2">
            <AiLabel />
            {confirmUrl && (
              <button type="button" onClick={() => (playingConfirm ? stopVoice() : void playUrl(confirmUrl, CONFIRM_KEY))}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-amber-100 px-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-300 active:scale-95">
                <Volume2 className={clsx('size-5', playingConfirm && 'animate-pulse')} /> {t('onboarding.replay')}
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-100">
            <InfoRow icon={UserRound} color="bg-brand-700" label={t('onboarding.nameLabel')} value={draft.display_name} missing={t('onboarding.notHeard')} />
            <InfoRow icon={MapPin} color="bg-sky-600" label={t('onboarding.areaLabel')} value={draft.home_area} missing={t('onboarding.notHeard')} />
            <InfoRow icon={Languages} color="bg-slate-700" label={t('onboarding.languageLabel')}
              value={<span lang={draft.language} className={draft.language === 'ur' ? 'font-urdu' : 'font-latin'}>{LANG_LABEL[draft.language]}</span>}
              action={
                <button type="button" onClick={() => setDraft({ ...draft, language: otherLang })} disabled={saving}
                  aria-label={t('onboarding.switchLanguage')} title={t('onboarding.switchLanguage')}
                  className="inline-flex min-h-11 items-center gap-1 rounded-full bg-slate-100 px-3 text-sm font-semibold text-slate-700 active:scale-95">
                  <span lang={otherLang} className={otherLang === 'ur' ? 'font-urdu' : 'font-latin'}>{LANG_LABEL[otherLang]}</span>
                </button>
              }
            />
          </div>
          {heard && (
            <p className="mt-2 rounded-2xl bg-slate-50 p-2.5 text-sm text-slate-600">
              <span className="font-semibold text-slate-500">{t('onboarding.heardLabel')}: </span>
              <span dir="auto">“{heard}”</span>
            </p>
          )}
        </section>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={retry} disabled={saving} aria-label={t('onboarding.noTryAgain')}
            className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-3xl bg-red-600 text-white shadow-lg shadow-red-600/25 transition active:scale-[0.97] disabled:opacity-50">
            <X className="size-14" strokeWidth={3} />
            <span className="text-base font-bold">{t('onboarding.noTryAgain')}</span>
          </button>
          <button type="button" onClick={() => { void save(draft) }} disabled={saving} aria-label={t('onboarding.yesCorrect')}
            className="onb-ready flex min-h-28 flex-col items-center justify-center gap-1 rounded-3xl bg-green-600 text-white shadow-lg shadow-green-600/25 transition active:scale-[0.97] disabled:opacity-60">
            {saving ? <Loader2 className="size-14 animate-spin" /> : <Check className="size-14" strokeWidth={3} />}
            <span className="text-base font-bold">{saving ? t('onboarding.saving') : t('onboarding.yesCorrect')}</span>
          </button>
        </div>

        <div className="mt-auto flex justify-center">
          <SubtleLink icon={Pencil} onClick={() => openForm()}>{t('onboarding.edit')}</SubtleLink>
        </div>
      </div>
    )
  }

  if (phase === 'typing') {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <StepHeading icon={Keyboard} title={t('onboarding.typeTitle')} prompt="profileAsk" autoPlay={false} />
        {notice}
        <form onSubmit={submitForm} className="space-y-4 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200" noValidate>
          <TextField id="onb-name" icon={UserRound} label={t('onboarding.nameLabel')} autoComplete="name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('onboarding.namePh')} maxLength={80} />
          <TextField id="onb-area" icon={MapPin} label={t('onboarding.areaLabel')} autoComplete="address-level3" value={form.area}
            onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder={t('onboarding.areaPh')} maxLength={80} />
          <div>
            <span className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
              <Languages className="size-4 text-slate-500" /> {t('onboarding.languageLabel')}
            </span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {(['ur', 'en'] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={form.language === l} onClick={() => setForm({ ...form, language: l })}
                  lang={l}
                  className={clsx(
                    'min-h-14 rounded-2xl border-2 text-lg font-bold transition active:scale-[0.98]',
                    l === 'ur' ? 'font-urdu' : 'font-latin',
                    form.language === l ? 'border-brand-700 bg-brand-50 text-brand-900' : 'border-slate-200 bg-white text-slate-700',
                  )}>
                  {LANG_LABEL[l]}
                </button>
              ))}
            </div>
          </div>
          {formErr && <p role="alert" className="text-sm font-semibold text-red-700">{t(`onboarding.${formErr}`)}</p>}
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
          <button type="submit" disabled={saving}
            className="inline-flex min-h-16 w-full items-center justify-center gap-2 rounded-full bg-green-600 text-xl font-black text-white shadow-lg shadow-green-600/25 transition active:scale-[0.98] disabled:opacity-60">
            {saving ? <Loader2 className="size-7 animate-spin" /> : <Check className="size-7" strokeWidth={3} />}
            {saving ? t('onboarding.saving') : t('onboarding.save')}
          </button>
        </form>
        {canRecord && (
          <div className="flex justify-center">
            <SubtleLink icon={Mic} onClick={() => { setMsg(null); setError(null); setPhase('ask') }}>{t('onboarding.speakInstead')}</SubtleLink>
          </div>
        )}
      </div>
    )
  }

  // phase === 'ask'
  const recording = rec.state === 'recording'
  return (
    <div className="flex flex-1 flex-col gap-4">
      <StepHeading icon={UserRound} title={t('onboarding.profileTitle')} hint={t('onboarding.profileHint')} prompt="profileAsk">
        <p className="text-sm italic text-slate-500">{t('onboarding.profileExample')}</p>
      </StepHeading>

      <div className="flex flex-col items-center gap-2 py-2">
        <div className="relative flex size-56 items-center justify-center">
          {recording ? (
            <span aria-hidden className="absolute inset-5 rounded-full bg-red-500/25 transition-transform duration-75"
              style={{ transform: `scale(${1 + rec.level * 0.5})` }} />
          ) : (
            <>
              <span aria-hidden className="onb-ring absolute inset-8 rounded-full bg-brand-500/30" />
              <span aria-hidden className="onb-ring onb-ring-delay absolute inset-8 rounded-full bg-brand-500/30" />
            </>
          )}
          <button
            type="button"
            onClick={toggleMic}
            aria-pressed={recording}
            aria-label={recording ? t('onboarding.stopRecording') : t('onboarding.startRecording')}
            className={clsx(
              'relative inline-flex size-40 items-center justify-center rounded-full text-white shadow-2xl transition active:scale-95',
              recording ? 'bg-red-600 shadow-red-600/40' : 'bg-brand-700 shadow-brand-700/40',
            )}
          >
            {recording ? <Square className="size-14 fill-current" /> : <Mic className="size-20" />}
          </button>
        </div>
        <p className="text-xl font-black text-ink" aria-live="polite">
          {recording ? t('onboarding.tapToStop') : t('onboarding.tapToSpeak')}
        </p>
        {recording && (
          <p className="inline-flex items-center gap-2 font-semibold text-red-700">
            <span className="size-2.5 animate-pulse rounded-full bg-red-600" />
            {t('onboarding.listening')}
            <span dir="ltr" className="font-latin tabular-nums">{clock(rec.durationMs)} / {clock(MAX_TAKE_MS)}</span>
          </p>
        )}
      </div>

      {notice}
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <div className="mt-auto flex justify-center pt-2">
        <SubtleLink icon={Keyboard} onClick={() => openForm()}>{t('onboarding.typeInstead')}</SubtleLink>
      </div>
    </div>
  )
}

function InfoRow({ icon: Icon, color, label, value, missing, action }: {
  icon: LucideIcon; color: string; label: string; value: ReactNode; missing?: string; action?: ReactNode
}) {
  const empty = value === '' || value === null || value === undefined
  return (
    <div className="flex items-center gap-3 py-3">
      <span className={clsx('inline-flex size-14 shrink-0 items-center justify-center rounded-2xl text-white', color)}>
        <Icon className="size-7" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-500">{label}</span>
        {empty
          ? <span className="block text-lg font-bold text-amber-700">{missing}</span>
          : <span className="block break-words text-2xl font-black leading-snug text-ink" dir="auto">{value}</span>}
      </span>
      {action}
    </div>
  )
}
