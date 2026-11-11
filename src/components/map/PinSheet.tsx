import clsx from 'clsx'
import {
  Building2, Camera, Clock, Keyboard, MapPinOff, Mic, Navigation, Share2, Square, ThumbsDown, ThumbsUp,
  Timer, Users, Utensils, Volume2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { distanceM } from '../../hooks/useGeolocation'
import { api, ApiError } from '../../lib/api'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import { supabase } from '../../lib/supabase'
import type { Lang, MapPin, PublicReport, VoteType } from '../../lib/types'
import { AttributeChips } from '../report/AttributeChips'
import {
  AiLabel, CategoryIcon, EmptyState, Sheet, Spinner, StatusBadge, UrgencyBadge, useTimeAgo,
} from '../ui'
import { VoiceGuide } from '../voice/VoiceGuide'
import { useFormatDistance } from './useFormatDistance'
import { UserUrgencyBadge } from './UserUrgencyBadge'

/** Same value as the server's VERIFY_THRESHOLD — used only to colour the confidence bar. */
const VERIFIED_AT = 0.7

export interface PinSheetProps {
  clusterId: string
  onClose: () => void
  /** live row from useClusters when available (keeps the sheet in sync with Realtime) */
  pin?: MapPin | null
  /** user's position, to show the distance */
  userLocation?: { lat: number; lng: number } | null
}

/** Bottom sheet for one map pin (= one cluster of reports). */
export function PinSheet(props: PinSheetProps) {
  // remount per cluster so all local state (votes, audio, notices) resets cleanly
  return <PinSheetBody key={props.clusterId} {...props} />
}

type Notice = { kind: 'info' | 'success' | 'error'; text: string }
type Counts = Pick<MapPin, 'confirm_count' | 'dispute_count'>
type Override = Partial<Pick<MapPin, 'status' | 'confidence' | 'confirm_count' | 'dispute_count' | 'ai_reason'>>

function isOwnReportError(e: unknown): boolean {
  if (e instanceof ApiError) return e.code === 'own_report' || /own_report/i.test(e.message)
  return e instanceof Error && /own_report/i.test(e.message)
}

function PinSheetBody({ clusterId, onClose, pin: livePin, userLocation }: PinSheetProps) {
  const { t, lang, pick } = useI18n()
  const { session } = useAuth()
  const timeAgo = useTimeAgo()
  const fmtDist = useFormatDistance()

  const [fetched, setFetched] = useState<MapPin | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')
  const [reports, setReports] = useState<PublicReport[] | null>(null)
  const [override, setOverride] = useState<Override | null>(null)
  const [myVote, setMyVote] = useState<VoteType | null>(null)
  const [voting, setVoting] = useState<VoteType | null>(null)
  const [ownFromServer, setOwnFromServer] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [photoOpen, setPhotoOpen] = useState(false)
  const noticeTimer = useRef<number | null>(null)

  const showNotice = useCallback((n: Notice, ms = 4000) => {
    setNotice(n)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms)
  }, [])
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current) }, [])

  // ---- load pin + reports ----
  const loadReports = useCallback(async () => {
    const { data, error } = await supabase
      .from('public_reports')
      .select('*')
      .eq('cluster_id', clusterId)
      .order('created_at', { ascending: true })
      .limit(50)
    if (!error) setReports((data ?? []) as PublicReport[])
    else setReports((r) => r ?? [])
  }, [clusterId])

  const load = useCallback(async () => {
    setLoadState('loading')
    const [pinRes] = await Promise.all([
      supabase.from('map_pins').select('*').eq('id', clusterId).maybeSingle(),
      loadReports(),
    ])
    if (pinRes.error) { setLoadState('error'); return }
    setFetched((pinRes.data as MapPin | null) ?? null)
    setLoadState(pinRes.data ? 'ok' : 'missing')
  }, [clusterId, loadReports])

  useEffect(() => { void load() }, [load])

  // the user's previous vote on this pin (RLS: own rows only)
  const uid = session?.user.id
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    void supabase
      .from('report_votes')
      .select('vote, created_at')
      .eq('cluster_id', clusterId)
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (cancelled) return
        const v = (data?.[0] as { vote?: VoteType } | undefined)?.vote
        if (v === 'confirm' || v === 'dispute') setMyVote(v)
      })
    return () => { cancelled = true }
  }, [clusterId, uid])

  // live updates: a new report joined the cluster -> refresh the list; server values supersede optimistic ones
  const liveReportKey = livePin ? `${livePin.report_count}|${livePin.last_report_at}` : ''
  const firstLiveKey = useRef(liveReportKey)
  useEffect(() => {
    if (!liveReportKey || liveReportKey === firstLiveKey.current) return
    firstLiveKey.current = liveReportKey
    void loadReports()
  }, [liveReportKey, loadReports])
  const liveVersion = livePin ? `${livePin.updated_at}|${livePin.status}|${livePin.confirm_count}|${livePin.dispute_count}|${livePin.confidence}` : ''
  const prevLiveVersion = useRef(liveVersion)
  useEffect(() => {
    if (liveVersion === prevLiveVersion.current) return
    prevLiveVersion.current = liveVersion
    // a fresh server row arrived: drop optimistic values (unless a vote is still in flight — its response wins)
    if (!voting) setOverride(null)
  }, [liveVersion, voting])

  const base = livePin ?? fetched
  const pin = useMemo<MapPin | null>(() => (base ? { ...base, ...override } : null), [base, override])

  // ---- audio (TTS) ----
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsCache = useRef(new Map<string, string>())
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle')
  useEffect(() => () => {
    const a = audioRef.current
    if (a) { a.pause(); a.removeAttribute('src') }
  }, [])

  const listen = useCallback(async () => {
    if (!pin) return
    if (audioState === 'playing') {
      audioRef.current?.pause()
      setAudioState('idle')
      return
    }
    if (audioState === 'loading') return
    const urText = pin.summary_ur || pin.title_ur
    const enText = pin.summary_en || pin.title_en
    let text: string | null = null
    let ttsLang: Lang = lang
    if (lang === 'ur') { text = urText || enText; ttsLang = urText ? 'ur' : 'en' } else { text = enText || urText; ttsLang = enText ? 'en' : 'ur' }
    if (!text) return
    setAudioState('loading')
    try {
      const key = `${ttsLang}|${text}`
      let url = ttsCache.current.get(key)
      if (!url) {
        url = (await api.tts(text, ttsLang)).url
        ttsCache.current.set(key, url)
      }
      audioRef.current?.pause()
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setAudioState('idle')
      audio.onerror = () => { setAudioState('idle'); showNotice({ kind: 'error', text: t('map.audioError') }) }
      await audio.play()
      setAudioState('playing')
    } catch {
      setAudioState('idle')
      showNotice({ kind: 'error', text: t('map.audioError') })
    }
  }, [pin, audioState, lang, showNotice, t])

  // ---- votes ----
  const isOwn = ownFromServer || Boolean(reports?.some((r) => r.is_mine))

  const vote = useCallback(async (v: VoteType) => {
    if (!pin || voting) return
    if (!session) { showNotice({ kind: 'info', text: t('map.signInToVote') }); return }
    if (isOwn) { showNotice({ kind: 'info', text: t('map.ownReport') }); return }
    if (myVote === v) return
    const prevCounts: Counts = { confirm_count: pin.confirm_count, dispute_count: pin.dispute_count }
    const prevVote = myVote
    const optimistic: Counts = {
      confirm_count: pin.confirm_count + (v === 'confirm' ? 1 : 0) - (prevVote === 'confirm' ? 1 : 0),
      dispute_count: pin.dispute_count + (v === 'dispute' ? 1 : 0) - (prevVote === 'dispute' ? 1 : 0),
    }
    setOverride((o) => ({ ...o, ...optimistic }))
    setMyVote(v)
    setVoting(v)
    try {
      const res = await api.vote(clusterId, v)
      setOverride((o) => ({
        ...o,
        status: res.status,
        confidence: res.confidence,
        confirm_count: res.confirm_count,
        dispute_count: res.dispute_count,
        ...(res.ai_reason ? { ai_reason: res.ai_reason } : {}),
      }))
      showNotice({ kind: 'success', text: t('map.voteThanks') })
    } catch (e) {
      setOverride((o) => ({ ...o, ...prevCounts }))
      setMyVote(prevVote)
      if (isOwnReportError(e)) {
        setOwnFromServer(true)
        showNotice({ kind: 'info', text: t('map.ownReport') }, 6000)
      } else {
        showNotice({ kind: 'error', text: t('map.voteError') })
      }
    } finally {
      setVoting(null)
    }
  }, [pin, voting, session, isOwn, myVote, clusterId, showNotice, t])

  // ---- share ----
  const share = useCallback(async () => {
    if (!pin) return
    const url = `${window.location.origin}/pin/${clusterId}`
    const cat = CATEGORY_META[pin.category] ?? CATEGORY_META.other
    const title = pick(pin.title_en, pin.title_ur) || (lang === 'ur' ? cat.ur : cat.en)
    const text = t('map.shareText', { title })
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: t('common.appName'), text, url })
        return
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        // fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`)
      showNotice({ kind: 'success', text: t('map.linkCopied') }, 2500)
    } catch {
      showNotice({ kind: 'error', text: t('common.error') })
    }
  }, [pin, clusterId, pick, lang, t, showNotice])

  // ---- render ----
  if (!pin) {
    return (
      <Sheet open onClose={onClose}>
        {loadState === 'loading' ? (
          <div className="flex justify-center p-10 text-brand-700"><Spinner className="size-10" /></div>
        ) : loadState === 'error' ? (
          <EmptyState icon={MapPinOff} title={t('common.error')}>
            <button type="button" onClick={() => void load()} className="mt-2 min-h-12 rounded-2xl bg-brand-700 px-5 font-semibold text-white">
              {t('common.retry')}
            </button>
          </EmptyState>
        ) : (
          <EmptyState icon={MapPinOff} title={t('map.notFound')} />
        )}
      </Sheet>
    )
  }

  const cat = CATEGORY_META[pin.category] ?? CATEGORY_META.other
  const title = pick(pin.title_en, pin.title_ur) || t('map.unknownTitle')
  const summary = pick(pin.summary_en, pin.summary_ur)
  const confPct = Math.round(Math.max(0, Math.min(1, pin.confidence || 0)) * 100)
  const confColor = (pin.confidence || 0) >= VERIFIED_AT ? STATUS_META.verified.color : STATUS_META.unconfirmed.color
  const dist = userLocation ? distanceM(userLocation, pin) : null
  const isFood = pin.category === 'food' || pin.food_servings != null || pin.safe_until != null
  const canVote = pin.status !== 'resolved'
  const voteDisabled = Boolean(voting) || isOwn || !session
  const hasAttributes = Boolean(pin.attributes && Object.keys(pin.attributes).length)

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <div className="flex items-center gap-3">
          <CategoryIcon category={pin.category} size={52} />
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: cat.color }}>
              {lang === 'ur' ? cat.ur : cat.en}
            </div>
            <div className="text-lg leading-snug font-bold">{title}</div>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* status row */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={pin.status} count={pin.report_count} />
          <UserUrgencyBadge value={pin.user_urgency} />
          <UrgencyBadge urgency={pin.urgency} className="py-1 text-sm" />
          <span className="inline-flex items-center gap-1 text-sm text-slate-600">
            <Clock className="size-4" />
            {t('map.firstReported', { t: timeAgo(pin.created_at) })}
          </span>
          {dist !== null && (
            <span className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700">
              <Navigation className="size-4" />
              {t('map.away', { d: fmtDist(dist) })}
            </span>
          )}
        </div>

        {/* what reporters told the AI intake (danger first) */}
        {hasAttributes && (
          <section aria-label={t('map.whatWeKnow')}>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-700">{t('map.whatWeKnow')}</h3>
              {/* attributes were structured by the intake AI from what reporters said */}
              <AiLabel />
            </div>
            <AttributeChips attributes={pin.attributes} />
          </section>
        )}

        {/* AI assessment */}
        <section className="rounded-2xl border border-violet-100 bg-violet-50/60 p-3">
          <div className="mb-2 flex items-center gap-2">
            <AiLabel />
            <span className="font-latin ms-auto text-sm font-bold" style={{ color: confColor }}>
              {t('common.confidence', { n: confPct })}
            </span>
          </div>
          <div
            className="h-2.5 w-full overflow-hidden rounded-full bg-white"
            role="meter"
            aria-label={t('map.aiConfidence')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={confPct}
          >
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${confPct}%`, background: confColor }} />
          </div>
          {summary && <p className="mt-3 text-base text-ink">{summary}</p>}
          {pin.ai_reason && (
            <p className="mt-2 text-sm text-slate-600">
              <span className="font-bold">{t('map.why')}: </span>
              {pin.ai_reason}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <span className="inline-flex items-center gap-1">
              <Users className="size-4" />
              {pin.reporter_count === 1 ? t('map.reporter1') : t('map.reporters', { n: pin.reporter_count })}
            </span>
            <span className="inline-flex items-center gap-1" title={t('map.confirmsCount', { n: pin.confirm_count })}>
              <ThumbsUp className="size-4 text-green-700" /> <span className="font-latin">{pin.confirm_count}</span>
            </span>
            <span className="inline-flex items-center gap-1" title={t('map.disputesCount', { n: pin.dispute_count })}>
              <ThumbsDown className="size-4 text-slate-500" /> <span className="font-latin">{pin.dispute_count}</span>
            </span>
          </div>
        </section>

        {/* photo */}
        {pin.photo_url && (
          <button type="button" onClick={() => setPhotoOpen((o) => !o)} className="overflow-hidden rounded-2xl bg-slate-100">
            <img
              src={pin.photo_url}
              alt={t('map.photoAlt')}
              loading="lazy"
              decoding="async"
              className={clsx('w-full', photoOpen ? 'max-h-[70dvh] object-contain' : 'h-52 object-cover')}
            />
          </button>
        )}

        {/* food */}
        {isFood && (pin.food_servings != null || pin.safe_until) && (
          <section className="flex flex-col gap-2 rounded-2xl p-3" style={{ background: CATEGORY_META.food.soft }}>
            {pin.food_servings != null && (
              <div className="flex items-center gap-2 font-bold" style={{ color: CATEGORY_META.food.color }}>
                <Utensils className="size-6" />
                {t('map.servings', { n: pin.food_servings })}
                {pin.food_type && <span className="font-normal text-slate-700">· {pin.food_type}</span>}
              </div>
            )}
            {pin.safe_until && <SafeCountdown until={pin.safe_until} />}
          </section>
        )}

        {/* claimed */}
        {pin.claimed_org_name && (
          <div className="flex items-center gap-2 rounded-2xl p-3 font-semibold" style={{ background: STATUS_META.in_progress.soft, color: STATUS_META.in_progress.color }}>
            <Building2 className="size-6 shrink-0" />
            {t('map.claimedBy', { org: pin.claimed_org_name })}
          </div>
        )}

        {/* confirm / dispute */}
        {canVote && (
          <div className="-mb-1 flex items-center gap-2">
            <VoiceGuide prompt="pinVerify" size={48} label={false} />
            <p className="min-w-0 flex-1 text-base font-bold text-ink">{t('map.verifyAsk')}</p>
          </div>
        )}
        {canVote && (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              aria-label={t('map.confirmAria')}
              aria-pressed={myVote === 'confirm'}
              disabled={voteDisabled}
              onClick={() => void vote('confirm')}
              className={clsx(
                'flex min-h-16 items-center justify-center gap-2 rounded-2xl bg-green-600 px-3 text-lg font-bold text-white transition active:scale-[0.98] disabled:opacity-50',
                myVote === 'confirm' && 'ring-4 ring-green-200',
              )}
            >
              {voting === 'confirm' ? <Spinner className="size-7" /> : <ThumbsUp className="size-7" strokeWidth={2.4} />}
              {t('map.confirm')}
              <span className="font-latin rounded-full bg-white/25 px-2 text-sm">{pin.confirm_count}</span>
            </button>
            <button
              type="button"
              aria-label={t('map.disputeAria')}
              aria-pressed={myVote === 'dispute'}
              disabled={voteDisabled}
              onClick={() => void vote('dispute')}
              className={clsx(
                'flex min-h-16 items-center justify-center gap-2 rounded-2xl px-3 text-lg font-bold transition active:scale-[0.98] disabled:opacity-50',
                myVote === 'dispute' ? 'bg-slate-600 text-white ring-4 ring-slate-200' : 'bg-slate-200 text-slate-800',
              )}
            >
              {voting === 'dispute' ? <Spinner className="size-7" /> : <ThumbsDown className="size-7" strokeWidth={2.4} />}
              {t('map.dispute')}
              <span className="font-latin rounded-full bg-black/10 px-2 text-sm">{pin.dispute_count}</span>
            </button>
          </div>
        )}
        {canVote && (isOwn || myVote) && !notice && (
          <p className="-mt-2 text-center text-sm font-semibold text-slate-600">
            {isOwn ? t('map.ownReport') : myVote === 'confirm' ? t('map.youConfirmed') : t('map.youDisputed')}
          </p>
        )}
        {notice && (
          <div
            role="status"
            aria-live="polite"
            className={clsx(
              '-mt-1 rounded-2xl px-3 py-2 text-center text-sm font-semibold',
              notice.kind === 'success' && 'bg-green-50 text-green-800',
              notice.kind === 'info' && 'bg-amber-50 text-amber-800',
              notice.kind === 'error' && 'bg-red-50 text-red-700',
            )}
          >
            {notice.text}
          </div>
        )}

        {/* listen / share / directions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void listen()}
            disabled={!summary && !pin.title_en && !pin.title_ur}
            className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 px-3 font-bold text-white transition active:scale-[0.98] disabled:opacity-50"
          >
            {audioState === 'loading' ? <Spinner className="size-6" /> : audioState === 'playing' ? <Square className="size-6" /> : <Volume2 className="size-6" />}
            {audioState === 'loading' ? t('map.preparingAudio') : audioState === 'playing' ? t('map.stop') : t('common.listen')}
          </button>
          <button
            type="button"
            onClick={() => void share()}
            aria-label={t('map.share')}
            title={t('map.share')}
            className="inline-flex size-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-ink transition active:scale-95"
          >
            <Share2 className="size-6" />
          </button>
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${pin.lat},${pin.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('map.directions')}
            title={t('map.directions')}
            className="inline-flex size-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-ink transition active:scale-95"
          >
            <Navigation className="size-6" />
          </a>
        </div>

        {/* reports */}
        <section>
          <h3 className="mb-2 text-base font-bold">{t('map.reportsTitle', { n: reports?.length ?? pin.report_count })}</h3>
          {reports === null ? (
            <div className="flex justify-center p-4 text-brand-700"><Spinner /></div>
          ) : (
            <ul className="flex flex-col gap-2">
              {reports.map((r) => <ReportRow key={r.id} report={r} />)}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">{t('map.updated', { t: timeAgo(pin.updated_at) })}</p>
        </section>
      </div>
    </Sheet>
  )
}

const MODE_ICON = { voice: Mic, photo: Camera, text: Keyboard } as const
const MODE_KEY = { voice: 'map.modeVoice', photo: 'map.modePhoto', text: 'map.modeText' } as const

function ReportRow({ report }: { report: PublicReport }) {
  const { t, pick } = useI18n()
  const timeAgo = useTimeAgo()
  const modes = (report.input_modes ?? []).filter((m): m is keyof typeof MODE_ICON => m in MODE_ICON)
  const text = pick(report.summary_en, report.summary_ur) || pick(report.title_en, report.title_ur)
  return (
    <li className={clsx('flex items-start gap-3 rounded-2xl border p-3', report.is_mine ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white')}>
      <div className="flex shrink-0 flex-col items-center gap-1">
        {modes.length === 0 ? (
          <span className="inline-flex size-9 items-center justify-center rounded-full bg-slate-100 text-slate-600"><Keyboard className="size-5" /></span>
        ) : modes.map((m) => {
          const Icon = MODE_ICON[m]
          return (
            <span key={m} title={t(MODE_KEY[m])} aria-label={t(MODE_KEY[m])} className="inline-flex size-9 items-center justify-center rounded-full bg-slate-100 text-slate-700">
              <Icon className="size-5" />
            </span>
          )
        })}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">{timeAgo(report.created_at)}</span>
          <UserUrgencyBadge value={report.user_urgency} size="sm" />
          {report.is_mine && (
            <span className="rounded-full bg-brand-700 px-2 py-0.5 text-xs font-bold text-white">{t('map.yours')}</span>
          )}
        </div>
        {text && <p className="mt-0.5 line-clamp-3 text-sm text-ink">{text}</p>}
        <AttributeChips attributes={report.attributes} compact max={4} className="mt-1.5" />
      </div>
      {report.photo_url && (
        <img src={report.photo_url} alt={t('map.photoAlt')} loading="lazy" decoding="async" className="size-14 shrink-0 rounded-xl bg-slate-100 object-cover" />
      )}
    </li>
  )
}

const LRI = String.fromCharCode(0x2066) // left-to-right isolate
const PDI = String.fromCharCode(0x2069) // pop directional isolate

/** Live countdown until cooked food is no longer safe. Only this tiny component re-renders every second. */
function SafeCountdown({ until }: { until: string }) {
  const { t } = useI18n()
  const end = useMemo(() => new Date(until).getTime(), [until])
  const [now, setNow] = useState(() => Date.now())
  const expired = now >= end
  useEffect(() => {
    if (expired) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [expired])
  if (!Number.isFinite(end)) return null
  if (expired) {
    return (
      <div className="flex items-center gap-2 font-bold text-red-700">
        <Timer className="size-6" />
        {t('map.expired')}
      </div>
    )
  }
  const s = Math.floor((end - now) / 1000)
  const hh = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  const urgent = s < 30 * 60
  return (
    <div className={clsx('flex items-center gap-2 font-bold', urgent ? 'text-red-700' : 'text-slate-800')}>
      <Timer className="size-6" />
      {/* LRI/PDI isolate the LTR clock inside Urdu text */}
      <span>{t('map.safeFor', { t: LRI + `${hh}:${mm}:${ss}` + PDI })}</span>
    </div>
  )
}
