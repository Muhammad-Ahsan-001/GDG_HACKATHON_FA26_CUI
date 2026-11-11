import clsx from 'clsx'
import { ChevronDown, Clock, CloudOff, RefreshCw, ShieldCheck, Sparkles, Square, Volume2, VolumeX, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import type { DigestResponse, Lang } from '../../lib/types'
import { playUrl, stopVoice, useVoicePlaying } from '../../lib/voice/player'
import { AiLabel, Spinner, useTimeAgo } from '../ui'
import { readLocal, writeLocal } from './utils'

/**
 * Daily AI summary card at the top of the dashboard list column.
 * api.digestDaily(orgId) -> last 24 h for that organisation (admins / "all" filter: city-wide).
 * Collapsible (remembered per device), Listen (server audio_url, else api.tts), refresh, generated time.
 */

const COLLAPSED_KEY = 'awaaz.dashboard.digestCollapsed'
const MEMO_MS = 3 * 60_000
const AUDIO_KEY = 'digest:daily'

/** last answer per scope, so switching org back and forth does not re-bill the model */
const memo = new Map<string, { at: number; res: DigestResponse; lang: Lang }>()

function voiceOf(res: DigestResponse, lang: Lang): { text: string; lang: Lang } {
  if (lang === 'ur') return res.ur ? { text: res.ur, lang: 'ur' } : { text: res.en, lang: 'en' }
  return res.en ? { text: res.en, lang: 'en' } : { text: res.ur, lang: 'ur' }
}

export function DailyDigest({ orgId, orgName }: { orgId: string | null; orgName?: string | null }) {
  const { t, lang } = useI18n()
  const timeAgo = useTimeAgo()
  const bodyId = useId()
  const playing = useVoicePlaying() === AUDIO_KEY

  const [collapsed, setCollapsed] = useState(() => readLocal(COLLAPSED_KEY, '0') === '1')
  const [data, setData] = useState<{ res: DigestResponse; lang: Lang } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<'offline' | 'failed' | null>(null)
  const [voice, setVoice] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const [, setTick] = useState(0)

  const req = useRef(0)
  const clip = useRef<{ text: string; lang: Lang; url: string } | null>(null)
  const langRef = useRef(lang)
  useEffect(() => { langRef.current = lang }, [lang])

  const scope = orgId ?? 'city'

  const load = useCallback(async (force: boolean) => {
    const my = ++req.current
    setError(null)
    const hit = memo.get(scope)
    if (!force && hit && Date.now() - hit.at < MEMO_MS) {
      setData({ res: hit.res, lang: hit.lang })
      setLoading(false)
      return
    }
    setLoading(true)
    const l = langRef.current
    try {
      const res = await api.digestDaily(orgId ?? undefined, l)
      if (my !== req.current) return
      if (!res || typeof res.en !== 'string') throw new Error('bad digest response')
      memo.set(scope, { at: Date.now(), res, lang: l })
      setData({ res, lang: l })
    } catch {
      if (my !== req.current) return
      setError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'failed')
    } finally {
      if (my === req.current) setLoading(false)
    }
  }, [orgId, scope])

  // (re)load when the organisation changes; a different org's summary must not linger
  useEffect(() => {
    setData(null)
    setVoice('idle')
    clip.current = null
    void load(false)
    return () => { req.current++ }
  }, [load])

  // stop our voice when leaving the dashboard
  useEffect(() => () => { if (clip.current) stopVoice() }, [])

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    writeLocal(COLLAPSED_KEY, next ? '1' : '0')
  }

  const onListen = async () => {
    if (!data) return
    if (playing) { stopVoice(); return }
    if (voice === 'loading') return
    const my = req.current
    const v = voiceOf(data.res, lang)
    if (!v.text) return
    let url = clip.current && clip.current.text === v.text && clip.current.lang === v.lang ? clip.current.url : undefined
    if (!url && data.res.audio_url && data.lang === lang) url = data.res.audio_url
    if (!url) {
      setVoice('loading')
      try {
        url = (await api.tts(v.text, v.lang)).url
      } catch {
        if (my === req.current) setVoice('unavailable')
        return
      }
    }
    if (my !== req.current) return
    clip.current = { text: v.text, lang: v.lang, url }
    setVoice('idle')
    void playUrl(url, AUDIO_KEY)
  }

  const res = data?.res
  const text = res ? voiceOf(res, lang).text : ''
  const quiet = res?.pin_count === 0
  const isOrg = Boolean(orgId && orgName)
  const title = isOrg ? t('dashboard.digestTitle') : t('dashboard.digestTitleCity')
  const scopeLine = isOrg ? t('dashboard.digestScopeOrg', { name: orgName ?? '' }) : t('dashboard.digestScopeCity')
  const n = res?.pin_count ?? 0
  const countLine = isOrg
    ? (n === 1 ? t('dashboard.digestCountAlerts1') : t('dashboard.digestCountAlerts', { n }))
    : (n === 1 ? t('dashboard.digestCountReports1') : t('dashboard.digestCountReports', { n }))
  const preview = loading && !res ? t('dashboard.digestLoading') : error && !res ? t('dashboard.digestError') : text || scopeLine
  const listenLabel = voice === 'loading' ? t('dashboard.digestPreparing') : playing ? t('dashboard.digestStop') : t('dashboard.digestListen')

  return (
    <section className="shrink-0 border-b border-slate-200 bg-white p-2.5" aria-label={title}>
      <div className="overflow-hidden rounded-2xl bg-amber-50 ring-1 ring-amber-200">
        {/* header: always visible (collapsed shows a one-line preview) */}
        <div className="flex items-center gap-2 p-2">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? t('dashboard.digestExpand') : t('dashboard.digestCollapse')}
            className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 text-start transition hover:bg-amber-100/60"
          >
            <span
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-amber-950"
              style={{ background: 'linear-gradient(140deg, #FDE68A, #F59E0B)' }}
            >
              <Sparkles className={clsx('size-5', loading && 'animate-pulse')} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-extrabold text-ink">{title}</span>
                {res?.ai && <AiLabel className="shrink-0" />}
              </span>
              <span dir={collapsed && text ? 'auto' : undefined} className="block truncate text-xs text-slate-600">
                {collapsed ? preview : scopeLine}
              </span>
            </span>
            <ChevronDown aria-hidden className={clsx('size-5 shrink-0 text-slate-500 transition-transform', !collapsed && 'rotate-180')} />
          </button>
          <button
            type="button"
            onClick={() => void onListen()}
            disabled={!res}
            aria-pressed={playing}
            aria-label={listenLabel}
            title={listenLabel}
            className={clsx(
              'relative inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full ps-1 pe-1 font-bold text-amber-950 shadow-sm transition active:scale-95 disabled:opacity-50 sm:pe-3.5',
              playing ? 'bg-amber-300 ring-2 ring-amber-500' : 'bg-amber-400',
            )}
          >
            <span className="relative inline-flex size-10 items-center justify-center rounded-full bg-white/50">
              {playing && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-white/50" />}
              {voice === 'loading'
                ? <Spinner className="size-5" />
                : playing ? <Square className="relative size-4 fill-current" /> : <Volume2 className="relative size-5" />}
            </span>
            <span className="hidden text-sm sm:inline">{listenLabel}</span>
          </button>
        </div>

        {!collapsed && (
          <div id={bodyId} className="px-3 pb-3">
            {loading && !res && (
              <div className="animate-pulse space-y-2.5 py-1" role="status" aria-busy="true" aria-label={t('dashboard.digestLoading')}>
                <div className="h-3.5 w-full rounded-full bg-amber-200/70" />
                <div className="h-3.5 w-11/12 rounded-full bg-amber-200/70" />
                <div className="h-3.5 w-3/4 rounded-full bg-amber-200/70" />
              </div>
            )}

            {error && (
              <div role="alert" className="mb-2 flex items-center gap-2 rounded-xl bg-red-50 p-2 text-sm font-semibold text-red-800 ring-1 ring-red-200">
                {error === 'offline' ? <WifiOff className="size-5 shrink-0" /> : <CloudOff className="size-5 shrink-0" />}
                <span className="min-w-0 flex-1">{error === 'offline' ? t('dashboard.digestOffline') : t('dashboard.digestError')}</span>
                <button
                  type="button"
                  onClick={() => void load(true)}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-white px-3 font-bold text-red-700 ring-1 ring-red-200"
                >
                  <RefreshCw className="size-4" /> {t('common.retry')}
                </button>
              </div>
            )}

            {res && (
              <div className={clsx('transition-opacity', loading && 'opacity-60')}>
                {quiet ? (
                  <p className="flex items-start gap-2 font-medium" style={{ color: STATUS_META.resolved.color }}>
                    <ShieldCheck className="mt-1 size-5 shrink-0" />
                    <span dir="auto" className="text-ink">{text}</span>
                  </p>
                ) : (
                  <p dir="auto" className="max-h-[32vh] overflow-y-auto text-[15px] font-medium leading-relaxed text-ink lg:max-h-60">{text}</p>
                )}
                {voice === 'unavailable' && (
                  <p role="status" className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                    <VolumeX className="size-4 shrink-0" /> {t('dashboard.digestNoVoice')}
                  </p>
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-slate-500">
              {res && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" /> {t('dashboard.digestGenerated', { t: timeAgo(res.generated_at) })}
                </span>
              )}
              {res && !quiet && <span>{countLine}</span>}
              {res && !res.ai && !quiet && (
                <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200">{t('dashboard.digestQuick')}</span>
              )}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void load(true)}
                disabled={loading}
                aria-label={t('dashboard.digestRefresh')}
                title={t('dashboard.digestRefresh')}
                className="inline-flex size-11 items-center justify-center rounded-full border border-amber-200 bg-white text-ink transition active:scale-95 disabled:opacity-60"
              >
                <RefreshCw className={clsx('size-5', loading && 'animate-spin')} />
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
