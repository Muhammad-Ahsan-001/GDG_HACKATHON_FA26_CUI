// Offline report capture (Phase 2): no AI conversation — mic (with the same silence checks), photo, urgency chips,
// location (GPS / chosen spot / map centre) and "Save — send when online" into the IndexedDB queue (src/lib/offlineQueue.ts).
// QueuedCard is the calm confirmation that follows; it watches the queue and turns into "sending…" live.
import clsx from 'clsx'
import {
  Camera, Check, CircleAlert, CircleCheck, CloudAlert, CloudOff, CloudUpload, Images, Inbox, Keyboard, Loader2, LocateFixed,
  MapPin, MapPinCheck, MapPinned, Mic, MicOff, Pause, PhoneCall, Play, RefreshCw, Save, ShieldAlert, Smartphone, Square,
  Trash2, Volume2, Wifi, WifiOff, X, type LucideIcon,
} from 'lucide-react'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Recorder } from '../../hooks/useRecorder'
import { USER_URGENCY_META, type UserUrgency } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'
import { flushQueue, useOfflineQueue, type ItemOutcome } from '../../lib/offlineQueue'
import { STATUS_META } from '../../lib/status'
import { VOICE_PROMPTS, playPrompt, playUrl, stopVoice, useVoicePlaying } from '../../lib/voice/player'
import { useOnline } from '../pwa/OfflineBanner'
import { VoiceGuide } from '../voice/VoiceGuide'
import type { Hint } from './Composer'
import { formatClock } from './intake'
import type { DraftPhoto } from './usePhotoDraft'

export type OfflineReason = 'offline' | 'network' | 'server'
export type OfflineLoc =
  | { kind: 'locating' }
  | { kind: 'gps'; accuracy: number }
  | { kind: 'picked'; label?: string }
  | { kind: 'map' }

const CLIP_KEY = 'offline-clip'
const URGENCY_ORDER: UserUrgency[] = ['emergency', 'urgent', 'can_wait']
const BARS = [0.45, 0.7, 1, 0.7, 0.45]

export function OfflineCapture(p: {
  reason: OfflineReason
  online: boolean
  /** an AI conversation was already under way (its turns are saved with the report) */
  carried: boolean
  /** open the text field straight away (the user came in through the keyboard button) */
  preferWrite?: boolean
  rec: Recorder
  micBlocked: boolean
  clip: { url: string; durationMs: number } | null
  onMic: () => void
  onCancelRec: () => void
  onRemoveClip: () => void
  photos: DraftPhoto[]
  photoBusy: number
  photoError: string | null
  roomForPhotos: boolean
  onCamera: () => void
  onGallery: () => void
  onRemovePhoto: (id: string) => void
  urgency: UserUrgency | null
  onUrgency: (u: UserUrgency) => void
  text: string
  onText: (v: string) => void
  loc: OfflineLoc
  onLocate: () => void
  onChooseMap: () => void
  hint: Hint | null
  onDismissHint: () => void
  saving: boolean
  saveError: string | null
  canSave: boolean
  onSave: () => void
  onTalkToAi: () => void
}) {
  const { t, lang } = useI18n()
  const recording = p.rec.state === 'recording'
  const [writeOpen, setWriteOpen] = useState(p.text.length > 0 || p.micBlocked || Boolean(p.preferWrite))
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (writeOpen && !p.text) inputRef.current?.focus({ preventScroll: true }) }, [writeOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const server = p.reason === 'server'
  const StatusIcon = server ? CloudAlert : WifiOff

  return (
    <>
      <div className="awaaz-chat-scroll -mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
        {/* why we are in this mode */}
        <section className={clsx('awaaz-bubble-in flex items-start gap-3 rounded-3xl p-3 ring-1',
          server ? 'bg-amber-50 text-amber-950 ring-amber-200' : 'bg-slate-100 text-slate-800 ring-slate-200')}>
          <span className={clsx('inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white',
            server ? 'bg-amber-600' : 'bg-slate-700')}>
            <StatusIcon className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold leading-snug">{t(server ? 'alerts.offline_serverTitle' : 'alerts.offline_captureTitle')}</h3>
            <p className="mt-0.5 text-sm leading-relaxed opacity-90">{t(server ? 'alerts.offline_serverBody' : 'alerts.offline_captureBody')}</p>
            {p.carried && (
              <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold text-green-800">
                <Check className="size-4" strokeWidth={3} /> {t('alerts.offline_carried')}
              </p>
            )}
          </div>
        </section>

        {p.online && p.reason !== 'server' && (
          <div className="awaaz-bubble-in flex items-center gap-2 rounded-2xl bg-green-50 p-2 ps-3 text-green-900 ring-1 ring-green-200">
            <Wifi className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 text-sm font-bold">{t('alerts.offline_backOnline')}</span>
            <button type="button" onClick={p.onTalkToAi}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-green-700 px-3 text-sm font-bold text-white active:scale-95">
              <Mic className="size-4" /> {t('alerts.offline_talkToAi')}
            </button>
          </div>
        )}

        {/* how urgent */}
        <section className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-slate-600">{t('report.howUrgent')}</span>
          <UrgencyRow value={p.urgency} onPick={p.onUrgency} />
        </section>
        {p.urgency === 'emergency' && <EmergencyCall />}

        {/* voice */}
        <section className="flex flex-col items-center gap-2 rounded-3xl bg-white p-3 ring-1 ring-slate-200">
          {p.clip && !recording ? (
            <ClipRow clip={p.clip} onRemove={p.onRemoveClip} onAgain={p.onMic} disabled={p.micBlocked} />
          ) : (
            <>
              <div className="flex w-full items-center justify-center gap-5">
                {recording ? (
                  <RoundButton icon={Trash2} label={t('report.discard')} onClick={p.onCancelRec} tone="danger" />
                ) : <span className="size-14" aria-hidden />}
                <BigMic rec={p.rec} blocked={p.micBlocked} onClick={p.onMic} />
                {recording ? (
                  <span className="font-latin inline-flex w-14 justify-center text-lg font-bold tabular-nums text-red-600" dir="ltr" role="timer">
                    {formatClock(p.rec.durationMs)}
                  </span>
                ) : <span className="size-14" aria-hidden />}
              </div>
              <p className={clsx('text-center text-sm font-semibold', recording ? 'text-red-600' : 'text-slate-500')}>
                {p.micBlocked ? VOICE_PROMPTS.micDenied[lang] : recording ? t('alerts.offline_recording') : t('alerts.offline_record')}
              </p>
            </>
          )}
        </section>

        {/* photos + write */}
        <section className="flex flex-col gap-2">
          {(p.photos.length > 0 || p.photoBusy > 0) && (
            <div className="flex flex-wrap gap-2">
              {p.photos.map((ph) => (
                <div key={ph.id} className="awaaz-bubble-in relative size-20 overflow-hidden rounded-2xl ring-1 ring-slate-200">
                  <img src={ph.url} alt={t('report.photoAlt')} className="size-full object-cover" />
                  <button type="button" onClick={() => p.onRemovePhoto(ph.id)} aria-label={t('report.removePhoto')} title={t('report.removePhoto')}
                    className="absolute end-1 top-1 inline-flex size-8 items-center justify-center rounded-full bg-black/60 text-white active:scale-95">
                    <X className="size-4" />
                  </button>
                </div>
              ))}
              {p.photoBusy > 0 && (
                <div className="inline-flex size-20 items-center justify-center rounded-2xl bg-slate-100 text-slate-500" aria-label={t('report.preparingPhoto')}>
                  <Loader2 className="size-6 animate-spin" />
                </div>
              )}
            </div>
          )}
          {p.photoError && <p role="alert" className="rounded-2xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">{p.photoError}</p>}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
            <Tile icon={Camera} label={t('alerts.offline_photo')} onClick={p.onCamera} disabled={!p.roomForPhotos} badge={p.photos.length} />
            <button type="button" onClick={p.onGallery} disabled={!p.roomForPhotos} aria-label={t('report.fromGallery')} title={t('report.fromGallery')}
              className="inline-flex min-h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-2xl bg-white text-xs font-semibold text-ink ring-1 ring-slate-200 active:scale-[0.98] disabled:opacity-40">
              <Images className="size-6" /> {t('report.fromGallery')}
            </button>
            <Tile icon={Keyboard} label={t('alerts.offline_write')} onClick={() => setWriteOpen((v) => !v)} active={writeOpen} />
          </div>
          {writeOpen && (
            <label className="awaaz-bubble-in block">
              <span className="sr-only">{t('report.textLabel')}</span>
              <input
                ref={inputRef}
                type="text"
                dir="auto"
                value={p.text}
                onChange={(e) => p.onText(e.target.value)}
                placeholder={t('alerts.offline_writePlaceholder')}
                maxLength={600}
                autoComplete="off"
                className="min-h-14 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 px-4 text-base outline-none transition focus:border-brand-600 focus:bg-white"
              />
            </label>
          )}
        </section>

        {/* where */}
        <LocationCard loc={p.loc} onLocate={p.onLocate} onChooseMap={p.onChooseMap} />
      </div>

      {/* footer: hint + save */}
      <div className="-mx-4 flex shrink-0 flex-col gap-2 border-t border-slate-100 bg-white px-4 pt-2.5">
        {p.hint && <HintRow hint={p.hint} onDismiss={p.onDismissHint} />}
        {p.saveError && (
          <p role="alert" className="flex items-start gap-2 rounded-2xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /> {p.saveError}
          </p>
        )}
        <button
          type="button"
          onClick={p.onSave}
          disabled={p.saving || recording}
          className={clsx(
            'relative inline-flex min-h-16 w-full items-center justify-center gap-3 rounded-2xl px-5 text-lg font-bold shadow-md transition active:scale-[0.98]',
            p.canSave ? 'bg-brand-700 text-white' : 'bg-slate-200 text-slate-500 shadow-none',
          )}
        >
          {p.canSave && !p.saving && <span aria-hidden className="awaaz-attn absolute inset-0 rounded-2xl ring-4 ring-brand-500/40" />}
          {p.saving ? <Loader2 className="relative size-6 animate-spin" /> : <Save className="relative size-6" />}
          <span className="relative">
            {p.saving ? t('alerts.offline_saving') : p.online ? t('alerts.offline_saveOnline') : t('alerts.offline_save')}
          </span>
        </button>
      </div>
    </>
  )
}

/** Emergency / Urgent / Can wait, full width. */
const UrgencyRow = memo(function UrgencyRow({ value, onPick }: { value: UserUrgency | null; onPick: (u: UserUrgency) => void }) {
  const { lang, t } = useI18n()
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('report.howUrgent')}>
      {URGENCY_ORDER.map((u) => {
        const m = USER_URGENCY_META[u]
        const Icon = m.icon
        const on = value === u
        return (
          <button
            key={u}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(u)}
            className={clsx(
              'relative flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-2xl border-2 px-1 font-bold transition active:scale-95',
              value && !on && 'opacity-60',
            )}
            style={on ? { background: m.color, borderColor: m.color, color: '#fff' } : { background: m.soft, borderColor: 'transparent', color: m.color }}
          >
            <Icon className="size-7" />
            <span className="text-center text-sm leading-tight">{lang === 'ur' ? m.ur : m.en}</span>
            {on && (
              <span className="awaaz-pop-in absolute -end-1.5 -top-1.5 inline-flex size-6 items-center justify-center rounded-full bg-white shadow" style={{ color: m.color }}>
                <Check className="size-4" strokeWidth={3} />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
})

/** Phone calls work without mobile data: for danger to life, call Rescue 1122 / Police 15 right away. */
export function EmergencyCall({ className }: { className?: string }) {
  const { t } = useI18n()
  const color = USER_URGENCY_META.emergency.color
  return (
    <section className={clsx('awaaz-bubble-in flex flex-col gap-2 rounded-3xl p-3 ring-1', className)}
      style={{ background: USER_URGENCY_META.emergency.soft, color }}>
      <p className="flex items-start gap-2 text-sm font-bold leading-snug">
        <ShieldAlert className="mt-0.5 size-5 shrink-0" /> {t('alerts.offline_emergencyCall')}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <a href="tel:1122" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl text-base font-bold text-white shadow-md active:scale-[0.98]" style={{ background: color }}>
          <PhoneCall className="size-6" /> {t('alerts.offline_call1122')}
        </a>
        <a href="tel:15" className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl border-2 bg-white text-base font-bold shadow-sm active:scale-[0.98]" style={{ color, borderColor: color }}>
          <PhoneCall className="size-6" /> {t('alerts.offline_call15')}
        </a>
      </div>
    </section>
  )
}

function BigMic({ rec, blocked, onClick }: { rec: Recorder; blocked: boolean; onClick: () => void }) {
  const { t } = useI18n()
  const recording = rec.state === 'recording'
  // 'denied' stays tappable (the user may have just allowed the mic in settings); 'unsupported' cannot record at all
  const disabled = rec.state === 'unsupported'
  return (
    <div className="relative flex size-[92px] items-center justify-center">
      {recording ? (
        <span aria-hidden className="absolute inset-0 rounded-full bg-red-500/25 transition-transform duration-100"
          style={{ transform: `scale(${1 + rec.level * 0.4})` }} />
      ) : !disabled && !blocked && <span aria-hidden className="awaaz-breathe absolute inset-1 rounded-full bg-brand-500/40" />}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled && !recording}
        aria-pressed={recording}
        aria-label={recording ? t('report.stopRecording') : t('report.startRecording')}
        className={clsx(
          'relative z-10 inline-flex size-[78px] select-none items-center justify-center rounded-full text-white shadow-xl transition active:scale-95',
          recording ? 'bg-red-600' : disabled || blocked ? 'bg-slate-300 shadow-none' : 'bg-brand-700',
        )}
      >
        {recording ? (
          <span className="flex flex-col items-center gap-1">
            <Square className="size-7 fill-current" />
            <span className="flex h-3 items-end gap-0.5" aria-hidden>
              {BARS.map((k, i) => <span key={i} className="w-1 rounded-full bg-white/90" style={{ height: `${3 + Math.round(rec.level * k * 9)}px` }} />)}
            </span>
          </span>
        ) : blocked ? <MicOff className="size-9" /> : <Mic className="size-10" />}
      </button>
    </div>
  )
}

/** The recorded voice note: play / pause, length, delete, record again. */
function ClipRow({ clip, onRemove, onAgain, disabled }: {
  clip: { url: string; durationMs: number }; onRemove: () => void; onAgain: () => void; disabled: boolean
}) {
  const { t } = useI18n()
  const playing = useVoicePlaying() === CLIP_KEY
  return (
    <div className="awaaz-bubble-in flex w-full flex-col gap-2">
      <div className="flex items-center gap-3 rounded-2xl bg-brand-50 p-2 ring-1 ring-brand-100">
        <button
          type="button"
          onClick={() => (playing ? stopVoice() : void playUrl(clip.url, CLIP_KEY))}
          aria-label={playing ? t('alerts.offline_stopClip') : t('alerts.offline_playClip')}
          title={playing ? t('alerts.offline_stopClip') : t('alerts.offline_playClip')}
          className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white shadow-md active:scale-95"
        >
          {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-bold text-brand-900">
            <CircleCheck className="size-4 text-green-600" /> {t('alerts.offline_clipReady')}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={clsx('flex h-5 items-center gap-1', playing && 'awaaz-wave')} aria-hidden>
              {[0.5, 0.9, 0.6, 1, 0.7].map((k, i) => (
                <span key={i} className="w-1.5 rounded-full bg-brand-500" style={{ height: `${Math.round(6 + k * 14)}px` }} />
              ))}
            </span>
            <span className="font-latin text-xs font-bold tabular-nums text-brand-700" dir="ltr">{formatClock(clip.durationMs)}</span>
          </div>
        </div>
        <button type="button" onClick={onRemove} aria-label={t('alerts.offline_deleteClip')} title={t('alerts.offline_deleteClip')}
          className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-white text-red-600 ring-1 ring-red-200 active:scale-95">
          <Trash2 className="size-5" />
        </button>
      </div>
      {!disabled && (
        <button type="button" onClick={onAgain}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 self-center rounded-full px-4 text-sm font-semibold text-slate-600 active:scale-95">
          <Mic className="size-4" /> {t('alerts.offline_recordAgain')}
        </button>
      )}
    </div>
  )
}

function LocationCard({ loc, onLocate, onChooseMap }: { loc: OfflineLoc; onLocate: () => void; onChooseMap: () => void }) {
  const { t } = useI18n()
  const view: Record<OfflineLoc['kind'], { icon: LucideIcon; tone: string; text: string }> = {
    locating: { icon: Loader2, tone: 'bg-slate-100 text-slate-700', text: t('alerts.offline_locLocating') },
    gps: { icon: LocateFixed, tone: 'bg-green-50 text-green-800 ring-1 ring-green-200', text: t('alerts.offline_locGps', { n: loc.kind === 'gps' ? Math.max(1, Math.round(loc.accuracy)) : 0 }) },
    picked: { icon: MapPinCheck, tone: 'bg-blue-50 text-blue-800 ring-1 ring-blue-200', text: (loc.kind === 'picked' && loc.label) || t('alerts.offline_locPicked') },
    map: { icon: MapPinned, tone: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200', text: t('alerts.offline_locMap') },
  }
  const v = view[loc.kind]
  const Icon = v.icon
  return (
    <section className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-slate-600">{t('alerts.offline_where')}</span>
      <div className={clsx('flex min-h-12 items-center gap-2 rounded-2xl px-3 text-sm font-semibold', v.tone)}>
        <Icon className={clsx('size-5 shrink-0', loc.kind === 'locating' && 'animate-spin')} />
        <span className="min-w-0 flex-1 truncate" dir="auto">{v.text}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onLocate}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white text-sm font-bold text-ink ring-1 ring-slate-200 active:scale-[0.98]">
          <LocateFixed className="size-5 text-blue-600" /> {t('alerts.offline_useGps')}
        </button>
        <button type="button" onClick={onChooseMap}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white text-sm font-bold text-ink ring-1 ring-slate-200 active:scale-[0.98]">
          <MapPin className="size-5 text-brand-700" /> {t('alerts.offline_chooseMap')}
        </button>
      </div>
    </section>
  )
}

function Tile({ icon: Icon, label, onClick, disabled, badge, active }: {
  icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean; badge?: number; active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'relative inline-flex min-h-16 items-center justify-center gap-2 rounded-2xl text-base font-bold shadow-sm transition active:scale-[0.98] disabled:opacity-40',
        active ? 'bg-brand-700 text-white' : 'bg-white text-ink ring-2 ring-slate-200',
      )}
    >
      <Icon className="size-7" /> {label}
      {!!badge && (
        <span className="font-latin absolute end-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-full bg-green-600 text-xs font-bold text-white">{badge}</span>
      )}
    </button>
  )
}

function RoundButton({ icon: Icon, label, onClick, tone }: { icon: LucideIcon; label: string; onClick: () => void; tone?: 'danger' }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={clsx('inline-flex size-14 shrink-0 items-center justify-center rounded-full shadow-sm ring-1 transition active:scale-95',
        tone === 'danger' ? 'bg-red-50 text-red-600 ring-red-200' : 'bg-white text-ink ring-slate-200')}>
      <Icon className="size-6" />
    </button>
  )
}

function HintRow({ hint, onDismiss }: { hint: Hint; onDismiss: () => void }) {
  const { lang, t } = useI18n()
  return (
    <div role="alert" className={clsx('awaaz-bubble-in flex items-start gap-2 rounded-2xl px-3 py-2',
      hint.tone === 'warn' ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200' : 'bg-slate-50 text-slate-700 ring-1 ring-slate-200')}>
      <CircleAlert className="mt-1 size-5 shrink-0" />
      <p dir="auto" className="min-w-0 flex-1 text-sm font-medium leading-relaxed">{VOICE_PROMPTS[hint.prompt]?.[lang] ?? ''}</p>
      <button type="button" onClick={() => { void playPrompt(hint.prompt, lang) }} aria-label={t('common.listen')} title={t('common.listen')}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-amber-800 ring-1 ring-amber-200 active:scale-95">
        <Volume2 className="size-5" />
      </button>
      <button type="button" onClick={onDismiss} aria-label={t('common.close')} title={t('common.close')}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full opacity-60 active:scale-95">
        <X className="size-5" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- confirmation

type Stage = 'saved' | 'internet' | 'map'

/**
 * Calm "saved on your phone" card. Live: saved ✓ → waiting for internet → sending → (the sheet swaps in the normal
 * ResultCard once the queue reports it placed). Rejected / dropped outcomes are shown here too.
 */
export function QueuedCard({ clientId, emergency, outcome, onNew, onClose }: {
  clientId: string
  emergency: boolean
  outcome?: ItemOutcome
  onNew: () => void
  onClose: () => void
}) {
  const { t, pick } = useI18n()
  const q = useOfflineQueue()
  const online = useOnline()
  const sending = q.flushing && q.current === clientId
  const waitingN = q.count

  if (outcome?.kind === 'rejected' || outcome?.kind === 'dropped') {
    const rejected = outcome.kind === 'rejected'
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center" role="alert">
        <span className={clsx('inline-flex size-20 items-center justify-center rounded-full', rejected ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700')}>
          {rejected ? <ShieldAlert className="size-10" /> : <CloudOff className="size-10" />}
        </span>
        <h3 className="text-xl font-bold">{t(rejected ? 'alerts.offline_rejectedTitle' : 'alerts.offline_droppedTitle')}</h3>
        <p className="max-w-sm text-slate-700" dir="auto">
          {rejected ? pick(outcome.res.rejected?.message_en, outcome.res.rejected?.message_ur) : t('alerts.offline_droppedBody')}
        </p>
        <div className="mt-2 flex w-full flex-col gap-2">
          <BigAction icon={Mic} onClick={onNew}>{t('alerts.offline_reportAnother')}</BigAction>
          <SmallAction onClick={onClose}>{t('alerts.offline_backToMap')}</SmallAction>
        </div>
      </div>
    )
  }

  const stage: Stage = sending ? 'map' : online ? 'map' : 'internet'
  const title = sending ? t('alerts.offline_sendingTitle') : t('alerts.offline_savedTitle')
  const body = online ? t('alerts.offline_savedBodyOnline') : t('alerts.offline_savedBody')

  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center" aria-live="polite">
      <div className="relative flex size-28 items-center justify-center">
        <span className={clsx('absolute inset-0 rounded-full', sending ? 'animate-ping bg-brand-500/20 [animation-duration:1.8s]' : 'bg-green-100')} aria-hidden />
        <span className="absolute inset-2 rounded-full bg-white shadow-inner" aria-hidden />
        <span className="awaaz-pop-in relative inline-flex size-20 items-center justify-center rounded-full text-white shadow-lg"
          style={{ background: sending ? undefined : STATUS_META.verified.color }}>
          {sending ? (
            <span className="inline-flex size-20 items-center justify-center rounded-full bg-brand-700"><CloudUpload className="size-10 animate-pulse" /></span>
          ) : (
            <>
              <Smartphone className="size-10" />
              <span className="absolute -bottom-1 -end-1 inline-flex size-8 items-center justify-center rounded-full bg-white shadow" style={{ color: STATUS_META.verified.color }}>
                <Check className="size-5" strokeWidth={3} />
              </span>
            </>
          )}
        </span>
      </div>

      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-xl font-bold">{title}</h3>
          <VoiceGuide prompt="offlineQueued" label={false} size={40} />
        </div>
        <p className="max-w-sm text-slate-600">{body}</p>
      </div>

      <Journey stage={stage} sending={sending} />

      <div className="flex flex-wrap items-center justify-center gap-2">
        {waitingN > 0 && (
          <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-sm font-bold text-slate-700">
            <Inbox className="size-4" />
            {waitingN === 1 ? t('alerts.offline_waitingOne') : t('alerts.offline_waiting', { n: waitingN })}
          </span>
        )}
        {online && !sending && q.ids.includes(clientId) && (
          <button type="button" onClick={() => { void flushQueue() }}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-brand-50 px-3 text-sm font-bold text-brand-800 ring-1 ring-brand-200 active:scale-95">
            <RefreshCw className="size-4" /> {t('alerts.offline_retryNow')}
          </button>
        )}
      </div>

      {emergency && <EmergencyCall className="w-full text-start" />}

      <div className="mt-1 flex w-full flex-col gap-2">
        <BigAction icon={Mic} onClick={onNew}>{t('alerts.offline_reportAnother')}</BigAction>
        <SmallAction onClick={onClose}>{t('alerts.offline_backToMap')}</SmallAction>
      </div>
    </div>
  )
}

/** Saved on phone → internet → on the map, as three icons (readable without reading). */
function Journey({ stage, sending }: { stage: Stage; sending: boolean }) {
  const { t } = useI18n()
  const steps: { key: Stage; icon: LucideIcon; label: string }[] = [
    { key: 'saved', icon: Smartphone, label: t('alerts.offline_savedTitle') },
    { key: 'internet', icon: Wifi, label: t('alerts.offline_backOnline') },
    { key: 'map', icon: MapPin, label: t('alerts.offline_placedTitle') },
  ]
  const at = steps.findIndex((s) => s.key === stage)
  return (
    <ol className="flex w-full max-w-xs items-center" aria-hidden>
      {steps.map((s, i) => {
        const done = i < at || (i === 0)
        const active = i === at
        const Icon = s.icon
        return (
          <li key={s.key} className="flex flex-1 items-center last:flex-none">
            <span className={clsx('inline-flex size-11 shrink-0 items-center justify-center rounded-full',
              done ? 'text-white' : active ? 'bg-brand-50 text-brand-700 ring-2 ring-brand-300' : 'bg-slate-100 text-slate-400',
              active && sending && 'animate-pulse')}
              style={done ? { background: STATUS_META.verified.color } : undefined}
              title={s.label}>
              {done ? <Check className="size-5" strokeWidth={3} /> : active && sending ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
            </span>
            {i < steps.length - 1 && (
              <span className={clsx('mx-1 h-1 flex-1 rounded-full', i < at ? 'bg-green-600' : 'bg-slate-200')} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function BigAction({ icon: Icon, onClick, children }: { icon: LucideIcon; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-700 px-5 text-lg font-bold text-white shadow-md active:scale-[0.98]">
      <Icon className="size-6" /> {children}
    </button>
  )
}

function SmallAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 font-semibold text-ink active:scale-[0.98]">
      <MapPin className="size-5" /> {children}
    </button>
  )
}
