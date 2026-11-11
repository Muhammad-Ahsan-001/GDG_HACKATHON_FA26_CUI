import clsx from 'clsx'
import { Mic, MicOff, Pause, Play, RotateCcw, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Recorder } from '../../hooks/useRecorder'
import { useI18n } from '../../lib/i18n'

const MIN_TAKE_MS = 800
const HOLD_MS = 700
const BAR_SHAPE = [0.35, 0.55, 0.75, 0.9, 1, 0.9, 0.75, 0.55, 0.35]

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Big-mic voice note input: tap to start / tap to stop, or press-and-hold; live level, timer, playback. */
export function VoicePanel({ rec }: { rec: Recorder }) {
  const { t } = useI18n()
  const [tooShort, setTooShort] = useState(false)
  const hold = useRef<{ downAt: number; started: boolean } | null>(null)
  const { state, durationMs, maxMs, reset } = rec

  // accidental taps produce a tiny take: drop it and say so
  useEffect(() => {
    if (state === 'stopped' && durationMs < MIN_TAKE_MS) {
      reset()
      setTooShort(true)
    }
  }, [state, durationMs, reset])

  const toggle = () => {
    setTooShort(false)
    if (state === 'recording') void rec.stop()
    else void rec.start()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not supported */ }
    hold.current = { downAt: performance.now(), started: state !== 'recording' }
    toggle()
  }
  const onPointerUp = () => {
    const h = hold.current
    hold.current = null
    // press-and-hold: releasing after a long press ends the take
    if (h?.started && performance.now() - h.downAt >= HOLD_MS && rec.state === 'recording') void rec.stop()
  }

  if (state === 'stopped' && rec.blob) return <Playback rec={rec} />

  const recording = state === 'recording'
  const unsupported = state === 'unsupported'
  const blocked = state === 'denied' || unsupported
  const leftS = Math.max(0, Math.ceil((maxMs - durationMs) / 1000))

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative flex size-36 items-center justify-center">
        {recording && (
          <span
            aria-hidden
            className="absolute inset-2 rounded-full bg-red-500/25 transition-transform duration-75"
            style={{ transform: `scale(${1 + rec.level * 0.45})` }}
          />
        )}
        <button
          type="button"
          aria-label={recording ? t('report.stopRecording') : t('report.startRecording')}
          aria-pressed={recording}
          disabled={unsupported}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { hold.current = null }}
          // keyboard activation (no onClick: pointer taps are handled on pointerdown so hold-to-talk works)
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) toggle() }
          }}
          onKeyUp={(e) => { if (e.key === ' ') e.preventDefault() }}
          onContextMenu={(e) => e.preventDefault()}
          className={clsx(
            'relative z-10 inline-flex size-28 touch-none select-none items-center justify-center rounded-full text-white shadow-xl transition active:scale-95 [-webkit-touch-callout:none]',
            recording ? 'bg-red-600' : blocked ? 'bg-slate-400' : 'bg-brand-700 hover:bg-brand-900',
          )}
        >
          {recording ? <Square className="size-11 fill-current" /> : blocked ? <MicOff className="size-14" /> : <Mic className="size-14" />}
        </button>
      </div>

      {recording ? (
        <>
          <div className="flex h-10 items-center gap-1.5" aria-hidden>
            {BAR_SHAPE.map((k, i) => (
              <span
                key={i}
                className="w-2 rounded-full bg-red-500 transition-[height] duration-75"
                style={{ height: `${8 + Math.round(rec.level * k * 32)}px` }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 text-red-600" role="timer" aria-live="off" aria-label={t('report.recording')}>
            <span className="size-2.5 animate-pulse rounded-full bg-red-600" />
            <span className="font-latin text-2xl font-bold tabular-nums" dir="ltr">{formatClock(durationMs)}</span>
            <span className="font-latin text-sm text-slate-400" dir="ltr">/ {formatClock(maxMs)}</span>
          </div>
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-red-100">
            <div className="h-full rounded-full bg-red-500" style={{ width: `${Math.min(100, (durationMs / maxMs) * 100)}%` }} />
          </div>
          <p className="text-base font-semibold text-slate-700">{t('report.tapToStop')}</p>
          {leftS <= 15 && <p className="text-sm font-semibold text-red-600">{t('report.timeLeft', { n: leftS })}</p>}
        </>
      ) : (
        <>
          <p className="text-lg font-bold text-ink">{t('report.tapToSpeak')}</p>
          {state === 'idle' && <p className="text-sm text-slate-500">{t('report.holdHint')}</p>}
          {tooShort && state === 'idle' && <p className="text-sm font-semibold text-amber-700">{t('report.tooShort')}</p>}
          {state === 'denied' && <Notice>{t('report.micDenied')}</Notice>}
          {state === 'unsupported' && <Notice>{t('report.micUnsupported')}</Notice>}
          {state === 'error' && <Notice>{t('report.micError')}</Notice>}
        </>
      )}
    </div>
  )
}

function Notice({ children }: { children: string }) {
  return (
    <p className="max-w-xs rounded-2xl bg-amber-50 px-3 py-2 text-center text-sm font-medium text-amber-800">{children}</p>
  )
}

function Playback({ rec }: { rec: Recorder }) {
  const { t } = useI18n()
  const audio = useRef<HTMLAudioElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const totalS = Math.max(0.1, rec.durationMs / 1000) // WebM blobs often report duration = Infinity

  useEffect(() => {
    if (!rec.blob) { setUrl(null); return }
    const u = URL.createObjectURL(rec.blob)
    setUrl(u)
    setPos(0)
    return () => URL.revokeObjectURL(u)
  }, [rec.blob])

  const togglePlay = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) void a.play().catch(() => setPlaying(false))
    else a.pause()
  }

  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-brand-50 p-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t('report.pause') : t('report.play')}
          className="inline-flex size-16 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white shadow-md active:scale-95"
        >
          {playing ? <Pause className="size-8 fill-current" /> : <Play className="size-8 fill-current" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-brand-900">
            <Mic className="size-4" /> {t('report.voiceReady')}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white" dir="ltr">
            <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.min(100, (pos / totalS) * 100)}%` }} />
          </div>
        </div>
        <span className="font-latin shrink-0 text-lg font-bold tabular-nums text-brand-900" dir="ltr">{formatClock(rec.durationMs)}</span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { audio.current?.pause(); rec.reset(); void rec.start() }}
          className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-white px-3 font-semibold text-ink shadow-sm active:scale-[0.98]"
        >
          <RotateCcw className="size-5" /> {t('report.reRecord')}
        </button>
        <button
          type="button"
          onClick={() => { audio.current?.pause(); rec.reset() }}
          aria-label={t('report.deleteVoice')}
          title={t('report.deleteVoice')}
          className="inline-flex size-12 items-center justify-center rounded-2xl bg-white text-red-600 shadow-sm active:scale-95"
        >
          <Trash2 className="size-5" />
        </button>
      </div>
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setPos(0) }}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
          className="hidden"
        />
      )}
    </div>
  )
}
