import clsx from 'clsx'
import {
  Ear, EarOff, Keyboard, Loader2, Mic, RotateCcw, Sparkles, UserRound, Volume2, VolumeX, X,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { attributeIcon } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'
import { playPrompt, playUrl, stopVoice, useVoicePlaying } from '../../lib/voice/player'
import { AiLabel } from '../ui'
import { formatClock, type Msg } from './intake'
import type { DraftPhoto } from './usePhotoDraft'

type AiMsg = Extract<Msg, { role: 'ai' }>
type UserMsg = Extract<Msg, { role: 'user' }>

/** Playing-state key for an AI bubble's clip (shared player). */
export const bubbleKey = (id: string) => `msg:${id}`

/** TTS URLs fetched on demand for bubbles that came without a clip (cached per page session). */
const ttsCache = new Map<string, string>()

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** The conversation: AI bubbles (teal sparkle) on the start side, the user's on the end side; auto-scrolls. */
export const ChatThread = memo(function ChatThread({ msgs, thinking, photos, onRemovePhoto, onRetry, afterGreeting, lastAiExtra, footer }: {
  msgs: Msg[]
  thinking: boolean
  photos: DraftPhoto[]
  onRemovePhoto: (id: string) => void
  onRetry: (msgId: string) => void
  /** rendered right under the greeting (first-turn urgency chips) */
  afterGreeting?: ReactNode
  /** rendered inside the newest AI reply bubble (e.g. the "take a photo" button when the AI asks for one) */
  lastAiExtra?: ReactNode
  /** rendered after the last bubble (photo card, photo status) */
  footer?: ReactNode
}) {
  const { t } = useI18n()
  const scroller = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  const atBottom = useRef(true)
  const last = msgs[msgs.length - 1]
  const lastSig = `${msgs.length}|${last?.id}|${last && last.role === 'user' ? last.status : ''}|${thinking ? 1 : 0}|${footer ? 1 : 0}|${lastAiExtra ? 1 : 0}`
  let lastAiIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'ai') { lastAiIdx = i; break } }

  // keep the newest content in view (instant on first paint, smooth afterwards) — but never scroll the top of a
  // new AI question out of sight: that is the thing the user has to hear / read
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const smooth = !first.current && !prefersReducedMotion()
    first.current = false
    let top = el.scrollHeight - el.clientHeight
    const ai = !thinking && last?.role === 'ai' ? el.querySelector<HTMLElement>('[data-last-ai]') : null
    if (ai) {
      const aiTop = ai.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8
      if (aiTop < top) top = Math.max(0, aiTop)
    }
    el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    atBottom.current = top >= el.scrollHeight - el.clientHeight - 2
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSig])

  // the area shrinks when the "what we know" card / chips grow: stay pinned to the newest bubble
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight })
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={scroller}
      className="awaaz-chat-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-1"
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72
      }}
      role="log"
      aria-live="polite"
      aria-label={t('report.conversation')}
    >
      <div className="flex flex-col gap-3">
        {msgs.map((m, i) => (
          <div key={m.id} className="flex flex-col gap-3" data-last-ai={i === lastAiIdx ? '' : undefined}>
            {m.role === 'ai'
              ? <AiBubble msg={m} extra={i === lastAiIdx && m.kind === 'reply' ? lastAiExtra : undefined} />
              : <UserBubble msg={m} photos={photos} onRemovePhoto={onRemovePhoto} onRetry={onRetry} />}
            {i === 0 && afterGreeting}
          </div>
        ))}
        {thinking && <ThinkingBubble />}
        {footer}
      </div>
    </div>
  )
})

function AiAvatar() {
  return (
    <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white shadow-sm ring-2 ring-brand-100">
      <Sparkles className="size-[18px]" />
    </span>
  )
}

function UserAvatar() {
  return (
    <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 ring-2 ring-white">
      <UserRound className="size-5" />
    </span>
  )
}

const AiBubble = memo(function AiBubble({ msg, extra }: { msg: AiMsg; extra?: ReactNode }) {
  const { t, lang, pick } = useI18n()
  const text = pick(msg.en, msg.ur)
  return (
    <div className="awaaz-bubble-in flex max-w-[92%] items-end gap-2 self-start">
      <AiAvatar />
      <div className={clsx(
        'min-w-0 rounded-3xl rounded-es-md px-4 py-3 shadow-sm ring-1',
        msg.kind === 'unheard' ? 'bg-amber-50 ring-amber-200' : 'bg-brand-50 ring-brand-100',
      )}>
        <p dir="auto" className="text-[1.05rem] leading-relaxed text-ink">{text}</p>
        <div className="mt-2 flex items-center gap-2">
          <ReplayButton msg={msg} text={text} lang={lang} label={t('report.replay')} />
          {msg.kind === 'reply' && <AiLabel />}
        </div>
        {extra}
      </div>
    </div>
  )
})

function ReplayButton({ msg, text, lang, label }: { msg: AiMsg; text: string; lang: 'ur' | 'en'; label: string }) {
  const playing = useVoicePlaying()
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const key = msg.prompt && !msg.audioUrl ? `${lang}:${msg.prompt}` : bubbleKey(msg.id)
  const isPlaying = playing === key

  const play = async () => {
    if (isPlaying) { stopVoice(); return }
    if (msg.audioUrl) { void playUrl(msg.audioUrl, key); return }
    if (msg.prompt) { void playPrompt(msg.prompt, lang); return }
    if (!text) return
    const cacheKey = `${lang}|${text}`
    let url = ttsCache.get(cacheKey)
    if (!url) {
      setState('loading')
      try {
        url = (await api.tts(text, lang)).url
        ttsCache.set(cacheKey, url)
      } catch {
        setState('failed')
        return
      }
    }
    setState('idle')
    void playUrl(url, key)
  }

  const Icon = state === 'loading' ? Loader2 : state === 'failed' ? VolumeX : Volume2
  return (
    <button
      type="button"
      onClick={() => { void play() }}
      aria-label={label}
      title={label}
      className={clsx(
        'relative inline-flex size-10 items-center justify-center rounded-full transition active:scale-95',
        isPlaying ? 'bg-brand-700 text-white' : 'bg-white text-brand-700 ring-1 ring-brand-100',
      )}
    >
      {isPlaying && <span aria-hidden className="awaaz-attn absolute inset-0 rounded-full bg-brand-500/40" />}
      <Icon className={clsx('relative size-5', state === 'loading' && 'animate-spin')} />
    </button>
  )
}

const UserBubble = memo(function UserBubble({ msg, photos, onRemovePhoto, onRetry }: {
  msg: UserMsg
  photos: DraftPhoto[]
  onRemovePhoto: (id: string) => void
  onRetry: (msgId: string) => void
}) {
  const { t, pick } = useI18n()

  if (msg.kind === 'photo') {
    const shots = photos.filter((p) => msg.photoIds?.includes(p.id))
    if (!shots.length) return null
    return (
      <div className="awaaz-bubble-in flex max-w-[88%] items-end gap-2 self-end">
        <div className="grid grid-cols-2 gap-1.5 rounded-3xl rounded-ee-md bg-brand-700 p-1.5 shadow-sm" style={{ gridTemplateColumns: shots.length === 1 ? '1fr' : undefined }}>
          {shots.map((p) => (
            <div key={p.id} className="relative size-28 overflow-hidden rounded-2xl bg-brand-100">
              <img src={p.url} alt={t('report.photoAlt')} className="size-full object-cover" decoding="async" />
              <button
                type="button"
                onClick={() => onRemovePhoto(p.id)}
                aria-label={t('report.removePhoto')}
                title={t('report.removePhoto')}
                className="absolute end-1 top-1 inline-flex size-11 items-center justify-center rounded-full bg-black/55 text-white active:scale-95"
              >
                <X className="size-5" />
              </button>
            </div>
          ))}
        </div>
        <UserAvatar />
      </div>
    )
  }

  const failed = msg.status === 'failed'
  const unheard = msg.status === 'unheard'
  const sending = msg.status === 'sending'
  const ChipIcon = msg.chip ? attributeIcon(msg.chip.icon) : null

  return (
    <div className="awaaz-bubble-in flex max-w-[88%] flex-col items-end gap-1 self-end">
      <div className="flex items-end gap-2">
        <div className={clsx(
          'min-w-0 rounded-3xl rounded-ee-md px-4 py-3 shadow-sm',
          unheard ? 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'
            : failed ? 'bg-white text-ink ring-2 ring-red-300'
              : 'bg-brand-700 text-white',
          sending && 'opacity-90',
        )}>
          {msg.kind === 'voice' && (
            unheard ? (
              <span className="flex items-center gap-2 font-semibold">
                <EarOff className="size-5 shrink-0" /> {t('report.notHeard')}
                <span className="font-latin text-sm opacity-70" dir="ltr">{formatClock(msg.durationMs ?? 0)}</span>
              </span>
            ) : sending || !msg.text ? (
              <span className="flex items-center gap-3">
                <Mic className="size-5 shrink-0" />
                {sending ? (
                  <span className="awaaz-wave flex h-6 items-center gap-1" aria-label={t('report.hearing')}>
                    {[0.6, 1, 0.75, 0.95, 0.55].map((h, i) => (
                      <span key={i} className="w-1.5 rounded-full bg-current" style={{ height: `${h * 24}px` }} />
                    ))}
                  </span>
                ) : (
                  <span className="text-sm font-semibold">{t('report.voiceNote')}</span>
                )}
                <span className="font-latin text-sm opacity-80" dir="ltr">{formatClock(msg.durationMs ?? 0)}</span>
              </span>
            ) : (
              <span className="block">
                <span className={clsx('mb-0.5 flex items-center gap-1 text-xs font-semibold', failed ? 'text-slate-500' : 'text-brand-100')}>
                  <Ear className="size-3.5" /> {t('report.whatWeHeard')}
                </span>
                <span dir="auto" className="block text-[1.05rem] leading-relaxed">“{msg.text}”</span>
              </span>
            )
          )}
          {msg.kind === 'text' && (
            <span className="flex items-start gap-2">
              <Keyboard className={clsx('mt-1 size-4 shrink-0', failed ? 'text-slate-400' : 'text-brand-100')} />
              <span dir="auto" className="text-[1.05rem] leading-relaxed">{msg.text}</span>
            </span>
          )}
          {msg.kind === 'chip' && msg.chip && ChipIcon && (
            <span className="flex items-center gap-2 text-[1.05rem] font-semibold">
              <ChipIcon className="size-5 shrink-0" />
              <span dir="auto">{pick(msg.chip.label_en, msg.chip.label_ur)}</span>
            </span>
          )}
        </div>
        <UserAvatar />
      </div>
      {failed && (
        <button
          type="button"
          onClick={() => onRetry(msg.id)}
          className="me-11 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-red-50 px-3.5 text-sm font-semibold text-red-700 ring-1 ring-red-200 active:scale-95"
        >
          <RotateCcw className="size-4" /> {t('report.notSentRetry')}
        </button>
      )}
    </div>
  )
})

function ThinkingBubble() {
  const { t } = useI18n()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 6000)
    return () => clearTimeout(id)
  }, [])
  return (
    <div className="awaaz-bubble-in flex items-end gap-2 self-start" role="status">
      <AiAvatar />
      <div className="flex min-h-12 items-center gap-3 rounded-3xl rounded-es-md bg-brand-50 px-4 py-3 ring-1 ring-brand-100">
        <span className="flex items-center gap-1.5" aria-hidden>
          <span className="awaaz-dot size-2.5 rounded-full bg-brand-600" />
          <span className="awaaz-dot size-2.5 rounded-full bg-brand-600" />
          <span className="awaaz-dot size-2.5 rounded-full bg-brand-600" />
        </span>
        <span className={clsx('text-sm text-brand-900', !slow && 'sr-only')}>{slow ? t('report.stillThinking') : t('report.thinking')}</span>
      </div>
    </div>
  )
}
