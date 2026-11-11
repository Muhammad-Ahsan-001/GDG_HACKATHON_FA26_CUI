import clsx from 'clsx'
import { CirclePlay, Headphones, ListMusic, Lock, RefreshCw, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { URGENCY_META } from '../../lib/categories'
import { api, ApiError } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import type { SosResponse, ThreatLevel } from '../../lib/sos'
import { playUrl, stopVoice, useVoicePlaying } from '../../lib/voice/player'
import { AiLabel, Spinner } from '../ui'

type Clip = NonNullable<SosResponse['evidence']>[number]
type LoadState = 'loading' | 'ok' | 'error' | 'forbidden'

const LRI = String.fromCharCode(0x2066) // left-to-right isolate (clock inside Urdu text)
const PDI = String.fromCharCode(0x2069)

/** Threat colours come from the shared urgency palette. */
const THREAT_STYLE: Record<ThreatLevel, { color: string } | null> = {
  none: null,
  possible: { color: URGENCY_META.high.color },
  high: { color: URGENCY_META.critical.color },
}

function clockTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return LRI + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + PDI
}

/**
 * Police-only SOS evidence: the recorded audio chunks (signed URLs, valid 1 h) with their transcripts.
 * Fetches fresh URLs every time it opens, on "refresh", and whenever `refreshKey` changes (new threat evidence).
 * One clip plays at a time (shared player); "Play all" plays them in order.
 */
export function SosEvidence({ sessionId, refreshKey }: { sessionId: string; refreshKey?: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<LoadState>('loading')
  const [clips, setClips] = useState<Clip[]>([])
  const seq = useRef(0)
  const run = useRef(0)
  const playing = useVoicePlaying()
  const keyOf = useCallback((c: Clip) => `sos:${sessionId}:${c.seq}`, [sessionId])
  const anyPlaying = clips.some((c) => playing === keyOf(c))

  const load = useCallback(async () => {
    const mine = ++seq.current
    setState((s) => (s === 'ok' ? s : 'loading'))
    try {
      const res = await api.sos({ action: 'evidence', session_id: sessionId })
      if (mine !== seq.current) return
      setClips([...(res.evidence ?? [])].sort((a, b) => a.seq - b.seq))
      setState('ok')
    } catch (e) {
      if (mine !== seq.current) return
      setState(e instanceof ApiError && (e.status === 403 || e.code === 'forbidden') ? 'forbidden' : 'error')
    }
  }, [sessionId])

  useEffect(() => { void load() }, [load, refreshKey])

  // stop our audio when the panel closes
  const anyPlayingRef = useRef(false)
  useEffect(() => { anyPlayingRef.current = anyPlaying }, [anyPlaying])
  useEffect(() => () => {
    run.current++
    if (anyPlayingRef.current) stopVoice()
  }, [])

  const playOne = (c: Clip) => {
    run.current++
    if (playing === keyOf(c)) { stopVoice(); return }
    void playUrl(c.url, keyOf(c))
  }

  const playAll = async () => {
    const mine = ++run.current
    if (anyPlaying) { stopVoice(); return }
    for (const c of clips) {
      if (run.current !== mine) return
      await playUrl(c.url, keyOf(c))
    }
  }

  return (
    <section className="mx-3 mb-1 rounded-2xl border border-slate-200 bg-white p-2.5" aria-label={t('dashboard.sosEvidence')}>
      <div className="flex flex-wrap items-center gap-2">
        <Headphones className="size-5 shrink-0 text-slate-700" />
        <span className="font-bold text-ink">{t('dashboard.sosEvidenceTitle')}</span>
        <AiLabel />
        <span className="flex-1" />
        {state === 'ok' && clips.length > 1 && (
          <button
            type="button"
            onClick={() => void playAll()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-brand-700 px-3 text-sm font-bold text-white"
          >
            {anyPlaying ? <Square className="size-4" /> : <ListMusic className="size-4" />}
            {anyPlaying ? t('dashboard.sosStop') : t('dashboard.sosPlayAll')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void load()}
          aria-label={t('dashboard.sosEvidenceRefresh')}
          title={t('dashboard.sosEvidenceRefresh')}
          className="inline-flex size-11 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>

      {state === 'loading' ? (
        <div className="flex justify-center p-4 text-red-600"><Spinner /></div>
      ) : state === 'forbidden' ? (
        <p className="mt-2 flex items-center gap-2 rounded-xl bg-slate-50 p-2 text-sm text-slate-700">
          <Lock className="size-4 shrink-0" /> {t('dashboard.sosEvidenceForbidden')}
        </p>
      ) : state === 'error' ? (
        <p className="mt-2 rounded-xl bg-red-50 p-2 text-sm font-semibold text-red-700">{t('dashboard.sosEvidenceError')}</p>
      ) : clips.length === 0 ? (
        <p className="mt-2 rounded-xl bg-slate-50 p-2 text-sm text-slate-600">{t('dashboard.sosEvidenceEmpty')}</p>
      ) : (
        <ol className="mt-2 max-h-80 space-y-1.5 overflow-y-auto overscroll-contain">
          {clips.map((c) => {
            const on = playing === keyOf(c)
            const threat = THREAT_STYLE[c.threat_level]
            return (
              <li
                key={c.seq}
                className={clsx('flex items-start gap-2 rounded-xl border p-1.5', on ? 'border-red-300 bg-red-50' : 'border-slate-100 bg-slate-50')}
                style={threat ? { borderInlineStartWidth: 4, borderInlineStartColor: threat.color } : undefined}
              >
                <button
                  type="button"
                  onClick={() => playOne(c)}
                  aria-label={on ? t('dashboard.sosStop') : t('dashboard.sosPlayClip', { n: c.seq + 1 })}
                  title={on ? t('dashboard.sosStop') : t('dashboard.sosPlayClip', { n: c.seq + 1 })}
                  className={clsx(
                    'inline-flex size-12 shrink-0 items-center justify-center rounded-full text-white transition active:scale-95',
                    on ? 'bg-red-600' : 'bg-brand-700',
                  )}
                >
                  {on ? <Square className="size-5" /> : <CirclePlay className="size-6" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-xs font-semibold text-slate-500">
                    <span>{t('dashboard.sosClip', { n: c.seq + 1 })}</span>
                    <span className="font-latin">{clockTime(c.created_at)}</span>
                    {threat && (
                      <span className="rounded-full px-1.5 font-bold text-white" style={{ background: threat.color }}>
                        {t(`dashboard.sosThreat_${c.threat_level}`)}
                      </span>
                    )}
                  </div>
                  <p dir="auto" className={clsx('mt-0.5 text-sm', c.transcript ? 'text-ink' : 'italic text-slate-400')}>
                    {c.transcript || t('dashboard.sosNoSpeech')}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
