// /sos — women's safety SOS mode (docs/CONTRACT-1B.md §SOS). Full screen, light (white / rose wash, red accents), SILENT (vibration only):
// listens in self-contained chunks, the server's AI checks each chunk for threats and alerts nearby police
// with the live location. "Send alert now" escalates by hand (works without the mic).
import clsx from 'clsx'
import {
  ArrowLeft, ArrowRight, CloudUpload, EyeOff, Info, Lock, MapPin, MapPinOff, Mic, MicOff, Phone, ShieldCheck, Siren, WifiOff,
} from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { parseTrigger, SOS_RED, SOS_RING, SOS_TRIGGER_ICON } from '../components/sos/meta'
import { DisguiseOverlay, Elapsed, HoldButton, ListeningRing } from '../components/sos/SosScreenParts'
import { useSosSession } from '../components/sos/useSosSession'
import '../components/sos/sos.css'
import { AiLabel, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useI18n } from '../lib/i18n'
import { newClientId } from '../lib/media'
import { USER_URGENCY_META } from '../lib/attributes'
import { STATUS_META } from '../lib/status'

/** Ignore taps on "Send alert now" right after the screen opens (the finger that held the SOS button). */
const CLICK_GUARD_MS = 800
const POLICE_TEL = 'tel:15'

type Kind = 'starting' | 'listening' | 'possible' | 'threat' | 'manual' | 'micOff' | 'ended'

function requestFullscreen() {
  try {
    const el = document.documentElement as HTMLElement & { requestFullscreen?: (o?: FullscreenOptions) => Promise<void> }
    void el.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined)
  } catch { /* unsupported */ }
}
function exitFullscreen() {
  try {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
  } catch { /* unsupported */ }
}

export default function SosPage() {
  const { t, pick, dir, lang } = useI18n()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuth()
  const [sessionId] = useState(() => newClientId())
  const [trigger] = useState(() => parseTrigger(params.get('trigger')))
  const s = useSosSession({ sessionId, trigger, uid: user?.id ?? null })
  const [disguised, setDisguised] = useState(false)
  const [mountedAt] = useState(() => performance.now())
  const leaving = useRef(false)

  const reveal = useCallback(() => { setDisguised(false); exitFullscreen() }, [])
  const disguise = () => { setDisguised(true); requestFullscreen() }

  const onAlert = () => {
    if (performance.now() - mountedAt < CLICK_GUARD_MS) return
    void s.sendAlert()
  }
  const onSafe = async () => {
    if (leaving.current) return
    leaving.current = true
    await s.finish()
    exitFullscreen()
    nav('/me', { replace: true })
  }
  const goBack = () => { exitFullscreen(); nav('/me', { replace: true }) }

  if (disguised) return <DisguiseOverlay onReveal={reveal} />

  // ---- what to show
  const micOk = s.mic === 'recording'
  const micBad = s.mic === 'denied' || s.mic === 'unsupported' || s.mic === 'error'
  const kind: Kind = s.endedBy ? 'ended'
    : s.alert ? (s.alert.source === 'ai' ? 'threat' : 'manual')
    : micOk && s.threat !== 'none' ? 'possible'
    : micOk ? 'listening'
    : micBad ? 'micOff'
    : 'starting'
  const alerted = kind === 'threat' || kind === 'manual'
  const ringColor = alerted ? SOS_RING.alerted
    : kind === 'possible' ? SOS_RING.possible
    : kind === 'listening' ? SOS_RING.listening
    : kind === 'ended' ? STATUS_META.verified.color
    : SOS_RING.idle
  const RingIcon = alerted ? Siren : kind === 'micOff' ? MicOff : kind === 'ended' ? ShieldCheck : Mic

  const title = kind === 'starting' ? t('sos.starting')
    : kind === 'listening' ? t('sos.listening')
    : kind === 'possible' ? t('sos.possible')
    : kind === 'threat' ? t('sos.threatAlerted')
    : kind === 'manual' ? t('sos.manualAlerted')
    : kind === 'micOff' ? t(s.mic === 'error' ? 'sos.micStopped' : 'sos.micOff')
    : s.endedBy === 'resolved' ? t('sos.endedResolved') : t('sos.endedOther')

  const reasonText = s.reason ? pick(s.reason.en, s.reason.ur) : ''
  const orgLine = s.orgs === null ? t('sos.alertedWaiting')
    : s.orgs.length ? t('sos.alertedTo', { orgs: s.orgs.join(lang === 'ur' ? '، ' : ', ') })
    : t('sos.noPoliceNearby')
  const noPolice = alerted && s.orgs !== null && s.orgs.length === 0
  const urgentCall = noPolice || s.alertSend === 'failed' || s.alertSend === 'retrying' || s.startTrouble
  const TriggerIcon = SOS_TRIGGER_ICON[trigger]
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-linear-to-b from-rose-50 via-white to-white text-slate-900">
      <div className="mx-auto flex min-h-full max-w-md flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
        {/* top bar */}
        <header className="flex items-center gap-2">
          <span className="font-latin inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-black text-white shadow-sm shadow-red-600/30" style={{ background: SOS_RED }}>
            <Siren className="size-4" /> {t('sos.sos')}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200" title={t('sos.privateLong')}>
            <Lock className="size-3.5" /> {t('sos.private')}
          </span>
          <Elapsed since={s.startedAt} className="ms-auto text-lg font-bold text-red-700" />
          {kind !== 'ended' && (
            <button
              type="button" onClick={disguise} title={t('sos.disguiseHint')}
              className="inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-4 font-semibold text-slate-800 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 active:bg-slate-100"
            >
              <EyeOff className="size-5" /> {t('sos.disguise')}
            </button>
          )}
        </header>

        {/* listening ring + status */}
        <section className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center" role="status">
          <ListeningRing color={ringColor} icon={RingIcon} pulse={micOk || alerted} readLevel={micOk ? s.readLevel : undefined} />
          <h1 className="text-2xl font-black leading-snug">{title}</h1>
          {(kind === 'threat' || kind === 'possible') && <AiLabel />}
          {kind === 'listening' && <p className="max-w-xs text-sm text-slate-600">{t('sos.listeningSub')}</p>}
          {alerted && <p className="max-w-xs font-semibold text-slate-800">{orgLine}</p>}
          {(kind === 'possible' || kind === 'threat') && reasonText && (
            <p className="max-w-xs text-sm text-slate-600">{reasonText}</p>
          )}
          {kind === 'micOff' && (
            <div className="max-w-xs space-y-3">
              <p className="text-sm text-slate-600">{t('sos.micOffBody')}</p>
              {s.mic !== 'unsupported' && (
                <button type="button" onClick={s.retryMic}
                  className="inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-5 font-bold text-slate-800 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 active:bg-slate-100">
                  <Mic className="size-5" /> {t('sos.micRetry')}
                </button>
              )}
            </div>
          )}
        </section>

        {kind === 'ended' ? (
          <button type="button" onClick={goBack}
            className="flex min-h-16 w-full items-center justify-center gap-3 rounded-3xl bg-white text-lg font-bold text-slate-800 shadow-md ring-1 ring-slate-200 hover:bg-slate-50 active:bg-slate-100">
            <BackIcon className="size-6" /> {t('sos.back')}
          </button>
        ) : (
          <>
            {/* live facts */}
            <div className="flex flex-wrap justify-center gap-2 text-sm">
              {s.geo.state === 'ok' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-slate-700 shadow-sm ring-1 ring-slate-200">
                  <MapPin className="size-4 text-green-700" /> {t('sos.locationOn', { m: s.geo.accuracy ?? 0 })}
                </span>
              ) : s.geo.state === 'locating' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-slate-600 shadow-sm ring-1 ring-slate-200">
                  <MapPin className="size-4 animate-pulse" /> {t('sos.locationWait')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-amber-800 ring-1 ring-amber-200">
                  <MapPinOff className="size-4" /> {t('sos.locationOff')}
                </span>
              )}
              {s.netIssue ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-amber-800 ring-1 ring-amber-200">
                  <WifiOff className="size-4" /> {t('sos.weakNet')}
                </span>
              ) : micOk ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-slate-700 shadow-sm ring-1 ring-slate-200">
                  <CloudUpload className="size-4" /> {s.sent ? t('sos.clipsSent', { n: s.sent }) : t('sos.clipsNone')}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">
                <TriggerIcon className="size-4" /> {t('sos.startedBy', { how: t(`sos.trigger_${trigger}`) })}
              </span>
            </div>

            {s.startTrouble && !alerted && (
              <div role="alert" className="mt-3 flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                <WifiOff className="mt-0.5 size-5 shrink-0" /> {t('sos.startTrouble')}
              </div>
            )}

            {/* actions */}
            <div className="mt-4 space-y-3">
              {!alerted ? (
                <button
                  type="button" onClick={onAlert} disabled={s.alertSend === 'sending' || s.alertSend === 'retrying' || s.finished}
                  className="flex min-h-24 w-full items-center justify-center gap-4 rounded-3xl px-5 py-4 text-start text-white shadow-2xl shadow-red-600/30 ring-4 ring-red-200 transition active:scale-[0.98] disabled:opacity-90"
                  style={{ background: SOS_RED }}
                >
                  {s.alertSend === 'sending' || s.alertSend === 'retrying'
                    ? <Spinner className="size-10 shrink-0" />
                    : <Siren className="size-10 shrink-0" />}
                  <span className="min-w-0">
                    <span className="block text-2xl font-black leading-tight">
                      {s.alertSend === 'sending' || s.alertSend === 'retrying' ? t('sos.sending') : t('sos.sendAlert')}
                    </span>
                    <span className="block text-sm font-semibold text-white/90">
                      {s.alertSend === 'retrying' ? t('sos.alertRetrying') : s.alertSend === 'failed' ? t('sos.alertFailed') : t('sos.sendAlertSub')}
                    </span>
                  </span>
                </button>
              ) : (
                <div className="flex items-center gap-3 rounded-3xl p-4 ring-2" style={{ background: USER_URGENCY_META.emergency.soft, ['--tw-ring-color' as string]: SOS_RED }}>
                  <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-white" style={{ background: SOS_RED }}>
                    <ShieldCheck className="size-7" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-lg font-black leading-tight text-red-800">{kind === 'threat' ? t('sos.threatAlerted') : t('sos.manualAlerted')}</span>
                    <span className="block text-sm text-slate-700">{orgLine}</span>
                  </span>
                </div>
              )}

              <a
                href={POLICE_TEL}
                className={clsx(
                  'flex min-h-14 w-full items-center justify-center gap-2 rounded-3xl font-bold transition active:scale-[0.98]',
                  urgentCall ? 'bg-red-600 text-white shadow-lg shadow-red-600/30' : 'bg-white text-red-700 shadow-sm ring-1 ring-red-200 hover:bg-red-50',
                )}
              >
                <Phone className="size-5" /> {t('sos.callPolice')}
              </a>

              <HoldButton
                label={t('sos.imSafe')} sub={t('sos.imSafeHold')} icon={ShieldCheck}
                color={STATUS_META.verified.color} busy={s.finished} onDone={() => { void onSafe() }}
              />
            </div>

            <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-slate-500">
              <Info className="mt-0.5 size-4 shrink-0" /> <span>{t('sos.limitNote')}</span>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
