import clsx from 'clsx'
import {
  Camera, CircleAlert, Keyboard, Loader2, Mic, MicOff, Send, SendHorizontal, Siren, Square, Trash2, Volume2, X,
} from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import type { Recorder } from '../../hooks/useRecorder'
import { USER_URGENCY_META, attributeIcon, type QuickReply } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'
import { VOICE_PROMPTS, playPrompt, type VoicePromptId } from '../../lib/voice/player'
import { VoiceGuide } from '../voice/VoiceGuide'
import { formatClock, isSendChip, isUserUrgency } from './intake'

export type Hint = { prompt: VoicePromptId; tone: 'warn' | 'info' }

const BARS = [0.45, 0.7, 1, 0.7, 0.45]

/** Bottom of the conversation: quick-reply chips, the big mic (camera + keyboard beside it), text row, Send. */
export function Composer({
  rec, micBlocked, thinking, quick, onChip, onMic, onCancelRec, onCamera, photoCount, askPhoto,
  textOpen, onTextOpen, text, onText, onSendText, canSend, ready, emergency, sendQueued, onSend, hint, onDismissHint,
}: {
  rec: Recorder
  micBlocked: boolean
  thinking: boolean
  quick: QuickReply[]
  onChip: (q: QuickReply) => void
  onMic: () => void
  onCancelRec: () => void
  onCamera: () => void
  photoCount: number
  askPhoto: boolean
  textOpen: boolean
  onTextOpen: (open: boolean) => void
  text: string
  onText: (v: string) => void
  onSendText: () => void
  canSend: boolean
  ready: boolean
  emergency: boolean
  sendQueued: boolean
  onSend: () => void
  hint: Hint | null
  onDismissHint: () => void
}) {
  const { t } = useI18n()
  const recording = rec.state === 'recording'
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (textOpen) inputRef.current?.focus({ preventScroll: true })
  }, [textOpen])

  return (
    <div className="-mx-4 flex flex-col gap-2 border-t border-slate-100 bg-white px-4 pt-2.5">
      {hint && <HintBar hint={hint} onDismiss={onDismissHint} />}

      {!recording && quick.length > 0 && (
        <QuickReplies quick={quick} disabled={thinking} onChip={onChip} />
      )}

      {micBlocked && !textOpen && !recording ? (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-2">
            <BigTile icon={Camera} label={t('report.tilePhoto')} onClick={onCamera} badge={photoCount} attention={askPhoto} />
            <BigTile icon={Keyboard} label={t('report.tileText')} onClick={() => onTextOpen(true)} />
          </div>
          {rec.state === 'denied' && (
            <button type="button" onClick={onMic}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 self-center rounded-full px-4 text-sm font-semibold text-slate-600 active:scale-95">
              <MicOff className="size-4" /> {t('report.tryMicAgain')}
            </button>
          )}
        </div>
      ) : textOpen && !recording ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); if (!thinking) onSendText() }}
        >
          <SideButton icon={micBlocked ? Camera : Mic} label={micBlocked ? t('report.tilePhoto') : t('report.backToVoice')}
            onClick={() => (micBlocked ? onCamera() : onTextOpen(false))} />
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t('report.textLabel')}</span>
            <input
              ref={inputRef}
              type="text"
              dir="auto"
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder={t('report.textPlaceholder')}
              maxLength={600}
              enterKeyHint="send"
              autoComplete="off"
              className="min-h-14 w-full rounded-full border-2 border-slate-200 bg-slate-50 px-5 text-base outline-none transition focus:border-brand-600 focus:bg-white"
            />
          </label>
          <button
            type="submit"
            disabled={thinking || text.trim().length < 2}
            aria-label={t('report.sendMessage')}
            title={t('report.sendMessage')}
            className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white shadow-md transition active:scale-95 disabled:bg-slate-300 disabled:shadow-none"
          >
            <SendHorizontal className="size-6 rtl:-scale-x-100" />
          </button>
        </form>
      ) : (
        <div className="flex items-center justify-center gap-5">
          {recording ? (
            <SideButton icon={Trash2} label={t('report.discard')} onClick={onCancelRec} tone="danger" />
          ) : (
            <SideButton icon={Camera} label={t('report.tilePhoto')} onClick={onCamera} badge={photoCount} attention={askPhoto} />
          )}
          <MicButton rec={rec} disabled={thinking || micBlocked} onClick={onMic} />
          {recording ? (
            <span className="font-latin inline-flex w-14 justify-center text-lg font-bold tabular-nums text-red-600" dir="ltr" role="timer">
              {formatClock(rec.durationMs)}
            </span>
          ) : (
            <SideButton icon={Keyboard} label={t('report.tileText')} onClick={() => onTextOpen(true)} />
          )}
        </div>
      )}

      {!textOpen && !micBlocked && (
        <p className={clsx('-mt-0.5 text-center text-sm font-semibold', recording ? 'text-red-600' : 'text-slate-500')}>
          {recording ? t('report.tapToFinish') : thinking ? t('report.waitForAi') : t('report.tapToSpeak')}
        </p>
      )}

      {canSend && !recording && (
        <div className="flex items-center gap-2">
          {ready && <VoiceGuide prompt="reportReady" label={false} size={48} />}
          <button
            type="button"
            onClick={onSend}
            disabled={sendQueued}
            className={clsx(
              'relative inline-flex min-h-14 flex-1 items-center justify-center gap-2.5 rounded-2xl px-5 text-lg font-bold shadow-md transition active:scale-[0.98]',
              emergency ? 'text-white'
                : ready ? 'bg-brand-700 text-white'
                  : 'bg-white text-brand-700 ring-2 ring-brand-700',
            )}
            style={emergency ? { background: USER_URGENCY_META.emergency.color } : undefined}
          >
            {ready && !sendQueued && <span aria-hidden className="awaaz-attn absolute inset-0 rounded-2xl ring-4 ring-brand-500/50" />}
            {sendQueued ? <Loader2 className="size-6 animate-spin" /> : emergency ? <Siren className="size-6" /> : <Send className="size-6 rtl:-scale-x-100" />}
            {sendQueued ? t('report.sendingSoon') : emergency ? t('report.sendEmergency') : ready ? t('report.sendReport') : t('report.sendNow')}
          </button>
        </div>
      )}
    </div>
  )
}

function MicButton({ rec, disabled, onClick }: { rec: Recorder; disabled: boolean; onClick: () => void }) {
  const { t } = useI18n()
  const recording = rec.state === 'recording'
  return (
    <div className="relative flex size-[92px] items-center justify-center">
      {recording ? (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-red-500/25 transition-transform duration-100"
          style={{ transform: `scale(${1 + rec.level * 0.4})` }}
        />
      ) : !disabled && <span aria-hidden className="awaaz-breathe absolute inset-1 rounded-full bg-brand-500/40" />}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled && !recording}
        aria-pressed={recording}
        aria-label={recording ? t('report.stopRecording') : t('report.startRecording')}
        className={clsx(
          'relative z-10 inline-flex size-[78px] select-none items-center justify-center rounded-full text-white shadow-xl transition active:scale-95',
          recording ? 'bg-red-600' : disabled ? 'bg-slate-300 shadow-none' : 'bg-brand-700 hover:bg-brand-900',
        )}
      >
        {recording ? (
          <span className="flex flex-col items-center gap-1">
            <Square className="size-7 fill-current" />
            <span className="flex h-3 items-end gap-0.5" aria-hidden>
              {BARS.map((k, i) => (
                <span key={i} className="w-1 rounded-full bg-white/90" style={{ height: `${3 + Math.round(rec.level * k * 9)}px` }} />
              ))}
            </span>
          </span>
        ) : rec.state === 'denied' || rec.state === 'unsupported' ? <MicOff className="size-9" /> : <Mic className="size-10" />}
      </button>
    </div>
  )
}

function SideButton({ icon: Icon, label, onClick, badge, attention, tone }: {
  icon: typeof Camera; label: string; onClick: () => void; badge?: number; attention?: boolean; tone?: 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={badge ? `${label} (${badge})` : label}
      title={label}
      className={clsx(
        'relative inline-flex size-14 shrink-0 items-center justify-center rounded-full shadow-sm ring-1 transition active:scale-95',
        tone === 'danger' ? 'bg-red-50 text-red-600 ring-red-200'
          : attention ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-ink ring-slate-200',
      )}
    >
      {attention && <span aria-hidden className="awaaz-attn absolute inset-0 rounded-full bg-brand-500/50" />}
      <Icon className="relative size-6" />
      {!!badge && (
        <span className="font-latin absolute -top-1 -end-1 inline-flex size-6 items-center justify-center rounded-full bg-green-600 text-xs font-bold text-white ring-2 ring-white">
          {badge}
        </span>
      )}
    </button>
  )
}

function BigTile({ icon: Icon, label, onClick, badge, attention }: {
  icon: typeof Camera; label: string; onClick: () => void; badge?: number; attention?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'relative flex min-h-[72px] items-center justify-center gap-2.5 rounded-2xl text-lg font-bold shadow-sm transition active:scale-[0.98]',
        attention ? 'bg-brand-700 text-white' : 'bg-white text-ink ring-2 ring-slate-200',
      )}
    >
      <Icon className="size-7" /> {label}
      {!!badge && (
        <span className="font-latin absolute end-2 top-2 inline-flex size-6 items-center justify-center rounded-full bg-green-600 text-xs font-bold text-white">{badge}</span>
      )}
    </button>
  )
}

const QuickReplies = memo(function QuickReplies({ quick, disabled, onChip }: {
  quick: QuickReply[]; disabled: boolean; onChip: (q: QuickReply) => void
}) {
  const { pick } = useI18n()
  const list = quick.slice(0, 4)
  // three choices fit one row as stacked tiles (icon over label): saves a whole row on small phones
  const stacked = list.length === 3
  return (
    <div className={clsx('grid gap-2', list.length === 1 ? 'grid-cols-1' : stacked ? 'grid-cols-3' : 'grid-cols-2')}>
      {list.map((q) => {
        const urgency = q.key === 'user_urgency' && isUserUrgency(q.value) ? USER_URGENCY_META[q.value] : null
        const send = isSendChip(q)
        const Icon = urgency ? urgency.icon : send ? Send : attributeIcon(q.icon)
        return (
          <button
            key={`${q.key}:${q.value}`}
            type="button"
            disabled={disabled}
            onClick={() => onChip(q)}
            className={clsx(
              'awaaz-bubble-in flex rounded-2xl border-2 font-bold transition active:scale-[0.97] disabled:opacity-50',
              stacked ? 'min-h-[68px] flex-col items-center justify-center gap-1 px-1 py-1.5 text-center'
                : 'min-h-14 items-center gap-2.5 px-2.5 py-1.5 text-start',
              send ? 'border-brand-700 bg-brand-700 text-white' : !urgency && 'border-slate-200 bg-white text-ink',
            )}
            style={urgency ? { background: urgency.soft, borderColor: urgency.color, color: urgency.color } : undefined}
          >
            <span
              className={clsx('inline-flex shrink-0 items-center justify-center rounded-full', stacked ? 'size-8' : 'size-10',
                send ? 'bg-white/20' : !urgency && 'bg-brand-50 text-brand-700')}
              style={urgency ? { background: urgency.color, color: '#fff' } : undefined}
            >
              <Icon className={clsx(stacked ? 'size-[18px]' : 'size-5', send && 'rtl:-scale-x-100')} />
            </span>
            <span dir="auto" className={clsx('min-w-0 leading-tight', stacked ? 'text-sm' : 'flex-1 text-[0.95rem]')}>
              {pick(q.label_en, q.label_ur)}
            </span>
          </button>
        )
      })}
    </div>
  )
})

function HintBar({ hint, onDismiss }: { hint: Hint; onDismiss: () => void }) {
  const { lang, t } = useI18n()
  const text = VOICE_PROMPTS[hint.prompt]?.[lang] ?? ''
  return (
    <div
      role="alert"
      className={clsx(
        'awaaz-bubble-in flex items-start gap-2 rounded-2xl px-3 py-2',
        hint.tone === 'warn' ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200' : 'bg-slate-50 text-slate-700 ring-1 ring-slate-200',
      )}
    >
      <CircleAlert className="mt-1 size-5 shrink-0" />
      <p dir="auto" className="min-w-0 flex-1 text-sm font-medium leading-relaxed">{text}</p>
      <button
        type="button"
        onClick={() => { void playPrompt(hint.prompt, lang) }}
        aria-label={t('common.listen')}
        title={t('common.listen')}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-amber-800 ring-1 ring-amber-200 active:scale-95"
      >
        <Volume2 className="size-5" />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-current opacity-60 active:scale-95"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}
