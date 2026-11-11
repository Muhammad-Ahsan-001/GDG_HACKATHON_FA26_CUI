import clsx from 'clsx'
import { BellRing, ChevronDown, Clock, Ear, Hourglass, Layers, Loader2, MapPin, MapPinPlus, Plus, Users, Utensils, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { ProcessReportResponse } from '../../lib/types'
import { AiLabel, CategoryIcon, StatusBadge, UrgencyBadge } from '../ui'
import { orgMeta } from './orgMeta'

/** Success screen after process-report: what the AI understood, where it went, who was alerted. */
export function ResultCard({ res, onSeeMap, onNew }: {
  res: ProcessReportResponse; onSeeMap: () => void; onNew: () => void
}) {
  const { t, pick, lang } = useI18n()
  const [count, setCount] = useState<number | null>(null)
  const title = pick(res.title_en, res.title_ur)
  const summary = pick(res.summary_en, res.summary_ur)

  // the response says "duplicate" but not how many reports the pin has now: read it from map_pins
  useEffect(() => {
    if (!res.is_duplicate || !res.cluster_id) return
    let alive = true
    void supabase.from('map_pins').select('report_count').eq('id', res.cluster_id).maybeSingle()
      .then(({ data }) => { if (alive && data) setCount((data as { report_count: number }).report_count) })
    return () => { alive = false }
  }, [res.is_duplicate, res.cluster_id])

  const fmtDistance = (m: number) => (m >= 1000 ? t('common.km', { n: (m / 1000).toFixed(1) }) : t('common.m', { n: Math.round(m) }))
  const safeUntil = res.food?.safe_until
    ? new Date(res.food.safe_until).toLocaleTimeString(lang === 'ur' ? 'ur-PK' : 'en-PK', { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-green-700">
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-green-600 text-white">
          <MapPin className="size-4" />
        </span>
        <span className="text-base font-bold">{t('report.resultTitle')}</span>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <CategoryIcon category={res.category} size={56} />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <AiLabel />
              <UrgencyBadge urgency={res.urgency} />
            </div>
            <h3 className="text-lg font-bold leading-snug" dir="auto">{title}</h3>
          </div>
          <ListenButton text={summary || title} />
        </div>
        {summary && <p className="mt-2 text-slate-700" dir="auto">{summary}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusBadge status={res.status} />
          <span className="font-latin text-xs text-slate-500" dir="ltr">{t('common.confidence', { n: Math.round(res.confidence * 100) })}</span>
        </div>
        {res.ai_reason && <p className="mt-1 text-sm text-slate-500" dir="auto">{res.ai_reason}</p>}
      </div>

      <div className={clsx('flex min-h-12 items-center gap-3 rounded-2xl px-3 py-2', res.is_duplicate ? 'bg-violet-50 text-violet-900' : 'bg-brand-50 text-brand-900')}>
        {res.is_duplicate ? <Layers className="size-6 shrink-0" /> : <MapPinPlus className="size-6 shrink-0" />}
        <span className="font-semibold">
          {res.is_duplicate ? (count ? t('report.joined', { n: count }) : t('report.joinedNoCount')) : t('report.newPin')}
        </span>
        {res.is_duplicate && <Users className="ms-auto size-5 shrink-0 opacity-60" />}
      </div>

      {res.food && (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-green-50 px-3 py-2.5 text-green-900">
          <div className="flex items-center gap-2 font-semibold">
            <Utensils className="size-5 shrink-0" />
            <span dir="auto">{res.food.food_type}</span>
          </div>
          {res.food.servings > 0 && (
            <div className="flex items-center gap-2 text-sm"><Users className="size-4 shrink-0" /> {t('report.foodServings', { n: res.food.servings })}</div>
          )}
          {safeUntil && (
            <div className="flex items-center gap-2 text-sm"><Hourglass className="size-4 shrink-0" /> {t('report.safeUntil', { time: safeUntil })}</div>
          )}
        </div>
      )}

      {res.routed.length > 0 ? (
        <div className="rounded-2xl bg-red-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-red-800">
            <BellRing className="size-5" /> {t('report.alertedTitle')}
          </div>
          <ul className="flex flex-col gap-1.5">
            {res.routed.map((o) => {
              const m = orgMeta(o.org_type)
              const Icon = m.icon
              return (
                <li key={`${o.org_type}-${o.org_name}`} className="flex min-h-12 items-center gap-3 rounded-xl bg-white px-3 py-1.5">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white" style={{ background: m.color }}>
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold" dir="auto">{t('report.alerted', { name: o.org_name })}</span>
                    <span className="block text-xs text-slate-500">{t(`report.org_${o.org_type}`)}</span>
                  </span>
                  {Number.isFinite(o.distance_m) && (
                    <span className="font-latin shrink-0 text-xs text-slate-500">{fmtDistance(o.distance_m)}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ) : res.status !== 'verified' && (
        <div className="flex min-h-12 items-center gap-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <Clock className="size-5 shrink-0" /> {t('report.noneAlerted')}
        </div>
      )}

      {res.transcript && (
        <details className="group rounded-2xl bg-slate-50 px-3">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
            <Ear className="size-5" /> {t('report.whatWeHeard')}
            <ChevronDown className="ms-auto size-5 transition group-open:rotate-180" />
          </summary>
          <p className="pb-3 text-slate-700" dir="auto">“{res.transcript}”</p>
        </details>
      )}

      <div className="flex flex-col gap-2 pt-1">
        <button
          type="button"
          onClick={onSeeMap}
          className="inline-flex min-h-16 items-center justify-center gap-3 rounded-2xl bg-brand-700 px-6 text-xl font-bold text-white shadow-lg active:scale-[0.98]"
        >
          <MapPin className="size-7" /> {t('report.seeOnMap')}
        </button>
        <button
          type="button"
          onClick={onNew}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 font-semibold text-brand-700 hover:bg-brand-50"
        >
          <Plus className="size-5" /> {t('report.newReport')}
        </button>
      </div>
    </div>
  )
}

/** Reads the AI summary aloud (tts Edge Function) — for users who cannot read. */
function ListenButton({ text }: { text: string }) {
  const { t, lang } = useI18n()
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'failed'>('idle')
  const audio = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => () => { audio.current?.pause() }, [])
  useEffect(() => { urlRef.current = null }, [text, lang])

  const play = async () => {
    if (state === 'playing') { audio.current?.pause(); setState('idle'); return }
    if (!text) return
    // create the element inside the tap so mobile browsers allow playback after the await
    const a = audio.current ?? new Audio()
    audio.current = a
    a.onended = () => setState('idle')
    a.onpause = () => setState((s) => (s === 'playing' ? 'idle' : s))
    try {
      if (!urlRef.current) {
        setState('loading')
        urlRef.current = (await api.tts(text, lang)).url
      }
      a.src = urlRef.current
      await a.play()
      setState('playing')
    } catch {
      setState('failed')
    }
  }

  const Icon = state === 'loading' ? Loader2 : state === 'failed' ? VolumeX : Volume2
  const label = state === 'failed' ? t('report.listenFailed') : t('common.listen')
  return (
    <button
      type="button"
      onClick={() => { void play() }}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-12 shrink-0 items-center justify-center rounded-full shadow-sm active:scale-95',
        state === 'playing' ? 'bg-brand-700 text-white' : state === 'failed' ? 'bg-slate-100 text-slate-400' : 'bg-brand-50 text-brand-700',
      )}
    >
      <Icon className={clsx('size-6', state === 'loading' && 'animate-spin', state === 'playing' && 'animate-pulse')} />
    </button>
  )
}
