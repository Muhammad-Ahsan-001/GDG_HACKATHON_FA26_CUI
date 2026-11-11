import clsx from 'clsx'
import {
  Camera, Check, CircleAlert, CloudAlert, CloudOff, Keyboard, LogIn, MapPin, MapPinned, MapPinOff, Megaphone, Mic,
  PencilLine, RotateCcw, Send, ShieldAlert, WifiOff, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useGeolocation, type GeoFix } from '../../hooks/useGeolocation'
import { useRecorder } from '../../hooks/useRecorder'
import { api, ApiError } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { MediaUploadError, newClientId, uploadAudio, uploadImages } from '../../lib/media'
import type { Category, ProcessReportRequest, ProcessReportResponse } from '../../lib/types'
import { Sheet } from '../ui'
import { CategoryHints } from './CategoryHints'
import { LocationChip } from './LocationChip'
import { PhotoPanel } from './PhotoPanel'
import { ProgressSteps, type StepKey } from './ProgressSteps'
import { ResultCard } from './ResultCard'
import { usePhotoDraft } from './usePhotoDraft'
import { VoicePanel } from './VoicePanel'

type Panel = 'voice' | 'photo' | 'text'
type ErrKind = 'offline' | 'network' | 'server' | 'upload' | 'auth'
type Phase =
  | { kind: 'compose' }
  | { kind: 'submitting'; steps: StepKey[]; active: number }
  | { kind: 'result'; res: ProcessReportResponse }
  | { kind: 'rejected'; rejected: NonNullable<ProcessReportResponse['rejected']> }
  | { kind: 'needs_location'; hints: string[] }
  | { kind: 'error'; error: ErrKind; detail?: string }

/** How long each simulated step stays "running" while the single process-report request is in flight. */
const STEP_MS: Partial<Record<StepKey, number>> = { listen: 3500, understand: 4500, duplicates: 3000 }
const GPS_WAIT_MS = 4000
const MIN_TEXT = 2

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function classifyError(e: unknown): ErrKind {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  if (e instanceof MediaUploadError) return e.code === 'network' ? 'network' : e.code === 'auth' ? 'auth' : 'upload'
  if (e instanceof ApiError) {
    if (e.status === 401) return 'auth'
    // FunctionsFetchError / FunctionsRelayError: no HTTP response body reached us
    if (e.body === undefined && /send a request|fetch|network|relay|load failed/i.test(e.message)) return 'network'
    return 'server'
  }
  if (e instanceof TypeError) return 'network'
  return 'server'
}

function hintsFromBody(body: unknown): string[] {
  const b = body as { needs_location?: { hints?: unknown }; hints?: unknown } | undefined
  const h = b?.needs_location?.hints ?? b?.hints
  return Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : []
}

export function ReportSheet(props: {
  open: boolean
  mode: 'voice' | 'photo' | 'text'
  onClose: () => void
  mapCenter: { lat: number; lng: number }
  onDone: (res: ProcessReportResponse) => void
}) {
  const { open, mode, onClose, mapCenter, onDone } = props
  const { t, lang, pick } = useI18n()
  const rec = useRecorder({ maxMs: 90_000 })
  const photos = usePhotoDraft()
  const geo = useGeolocation()

  const [panel, setPanel] = useState<Panel>(mode)
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' })
  const [text, setText] = useState('')
  const [address, setAddress] = useState('')
  const [addressOpen, setAddressOpen] = useState(false)
  const [categoryHint, setCategoryHint] = useState<Category | null>(null)
  const [autoCamera, setAutoCamera] = useState(false)
  const [needInput, setNeedInput] = useState(false)

  const textRef = useRef<HTMLTextAreaElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const locatePromise = useRef<Promise<GeoFix | null> | null>(null)
  /** last attempt that failed in transit: retrying the SAME draft reuses its client_id (server is idempotent) */
  const attempt = useRef<{ clientId: string; sig: string } | null>(null)
  const audioCache = useRef<{ blob: Blob; path: string } | null>(null)
  const imageCache = useRef<{ key: string; paths: string[] } | null>(null)
  const blobIds = useRef(new WeakMap<Blob, number>())
  const blobSeq = useRef(0)
  const busy = useRef(false)
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasOpen = useRef(false)
  const openRef = useRef(open)
  const resultSeen = useRef(false)
  const phaseRef = useRef<Phase>(phase)

  const { reset: resetRecorder, stop: stopRecorder } = rec
  const { locate } = geo
  const clearPhotos = photos.clear
  const photoCount = photos.photos.length

  const resetDraft = useCallback(() => {
    resetRecorder()
    clearPhotos()
    setText('')
    setAddress('')
    setAddressOpen(false)
    setCategoryHint(null)
    setNeedInput(false)
    attempt.current = null
    audioCache.current = null
    imageCache.current = null
  }, [resetRecorder, clearPhotos])

  useEffect(() => { phaseRef.current = phase }, [phase])

  // open / close transitions
  useEffect(() => {
    openRef.current = open
    if (open && !wasOpen.current) {
      if (phaseRef.current.kind === 'result') {
        if (resultSeen.current) { resetDraft(); setPhase({ kind: 'compose' }) }
        else resultSeen.current = true // finished while the sheet was closed: show it now
      }
      setPanel(mode)
      setAutoCamera(mode === 'photo' && photoCount === 0)
      locatePromise.current = locate()
    }
    // closing keeps the take (or cancels a start still waiting for mic permission)
    if (!open && wasOpen.current) void stopRecorder()
    wasOpen.current = open
  }, [open, mode, locate, photoCount, resetDraft, stopRecorder])

  // the map may switch the mode while the sheet is already open
  useEffect(() => { if (open) setPanel(mode) }, [open, mode])

  // text mode: put the cursor in the box straight away
  useEffect(() => {
    if (open && panel === 'text' && phase.kind === 'compose') textRef.current?.focus({ preventScroll: true })
  }, [open, panel, phase.kind])

  useEffect(() => () => { if (stepTimer.current) clearTimeout(stepTimer.current) }, [])

  const onAutoOpened = useCallback(() => setAutoCamera(false), [])

  const choosePanel = (p: Panel) => {
    if (p !== 'voice' && rec.state === 'recording') void rec.stop() // keep the take, don't record hidden
    setPanel(p)
    setNeedInput(false)
  }

  const blobId = (b: Blob | null) => {
    if (!b) return 0
    let id = blobIds.current.get(b)
    if (!id) { id = ++blobSeq.current; blobIds.current.set(b, id) }
    return id
  }

  const stopStepTimer = () => {
    if (stepTimer.current) clearTimeout(stepTimer.current)
    stepTimer.current = null
  }

  const runStepTimer = (steps: StepKey[], from: number) => {
    stopStepTimer()
    const schedule = (i: number) => {
      const key = steps[i]
      const ms = STEP_MS[key]
      if (i >= steps.length - 1 || !ms) return // last step keeps spinning until the response arrives
      stepTimer.current = setTimeout(() => {
        setPhase((p) => (p.kind === 'submitting' ? { ...p, active: Math.max(p.active, i + 1) } : p))
        schedule(i + 1)
      }, ms)
    }
    schedule(from)
  }

  const hasText = text.trim().length >= MIN_TEXT
  const hasInput = rec.state === 'recording' || Boolean(rec.blob) || photos.photos.length > 0 || hasText

  const submit = async (opts: { forceMap?: boolean } = {}) => {
    if (busy.current) return
    busy.current = true
    try {
      // one tap = stop the running take and send it
      let audioBlob = rec.blob
      let audioMime = rec.mime
      if (rec.state === 'recording') {
        audioBlob = await rec.stop()
        audioMime = audioBlob?.type || audioMime
      }
      const body = text.trim()
      const addr = address.trim()
      const shots = photos.photos
      if (!audioBlob && shots.length === 0 && body.length < MIN_TEXT) { setNeedInput(true); return }
      setNeedInput(false)

      const steps: StepKey[] = ['upload', ...(audioBlob ? (['listen'] as const) : []), 'understand', 'duplicates', 'pin']
      setPhase({ kind: 'submitting', steps, active: 0 })

      try {
        // --- location: GPS > typed address (server geocodes) > map centre
        let fix = geo.state === 'ok' ? geo.fix : null
        if (!fix && geo.state === 'locating' && locatePromise.current) {
          fix = await Promise.race([locatePromise.current, sleep(GPS_WAIT_MS).then(() => null)])
        }
        let loc: Pick<ProcessReportRequest, 'lat' | 'lng' | 'accuracy_m' | 'location_source'>
        if (opts.forceMap) loc = { lat: mapCenter.lat, lng: mapCenter.lng, location_source: 'map' }
        else if (fix) loc = { lat: fix.lat, lng: fix.lng, accuracy_m: Math.round(fix.accuracy), location_source: 'gps' }
        else if (addr) loc = {}
        else loc = { lat: mapCenter.lat, lng: mapCenter.lng, location_source: 'map' }

        // --- idempotency key
        const sig = [blobId(audioBlob), shots.map((p) => p.id).join(','), body, addr, categoryHint ?? ''].join('|')
        const clientId = attempt.current?.sig === sig ? attempt.current.clientId : newClientId()
        attempt.current = { clientId, sig }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new MediaUploadError('network', 'offline')

        // --- uploads (skipped for media already uploaded by an earlier attempt)
        const imageKey = shots.map((p) => p.id).join(',')
        const [audio_path, image_paths] = await Promise.all([
          !audioBlob ? Promise.resolve(undefined)
            : audioCache.current?.blob === audioBlob ? Promise.resolve(audioCache.current.path)
              : uploadAudio(audioBlob, audioMime, clientId).then((path) => { audioCache.current = { blob: audioBlob, path }; return path }),
          shots.length === 0 ? Promise.resolve(undefined)
            : imageCache.current?.key === imageKey ? Promise.resolve(imageCache.current.paths)
              : uploadImages(shots.map((p) => p.blob), clientId).then((paths) => { imageCache.current = { key: imageKey, paths }; return paths }),
        ])

        setPhase((p) => (p.kind === 'submitting' ? { ...p, active: 1 } : p))
        runStepTimer(steps, 1)

        const res = await api.processReport({
          client_id: clientId,
          text: body || undefined,
          audio_path,
          image_paths,
          ...loc,
          address_text: addr || undefined,
          language: 'auto',
          ui_language: lang,
          category_hint: categoryHint ?? undefined,
        })
        stopStepTimer()
        setPhase((p) => (p.kind === 'submitting' ? { ...p, active: p.steps.length } : p))
        await sleep(450) // let the last tick land

        attempt.current = null
        if (res.rejected) {
          setPhase({ kind: 'rejected', rejected: res.rejected })
        } else if (res.needs_location) {
          setPhase({ kind: 'needs_location', hints: res.needs_location.hints ?? [] })
        } else {
          resetDraft()
          resultSeen.current = openRef.current
          setPhase({ kind: 'result', res })
        }
      } catch (e) {
        stopStepTimer()
        if (e instanceof ApiError && e.code === 'needs_location') {
          attempt.current = null // nothing was stored: the next try gets a fresh client_id
          setPhase({ kind: 'needs_location', hints: hintsFromBody(e.body) })
          return
        }
        const kind = classifyError(e)
        // OFFLINE_QUEUE_HOOK: Phase 2 — when kind is 'offline' | 'network', enqueue
        // { client_id: attempt.current.clientId, request fields, audio blob, photo blobs } to IndexedDB
        // (src/lib/offlineQueue.ts) and replay on reconnect / Background Sync instead of only offering retry.
        setPhase({ kind: 'error', error: kind, detail: e instanceof Error ? e.message : undefined })
      }
    } finally {
      busy.current = false
    }
  }

  const backToCompose = (focusAddress = false) => {
    setPhase({ kind: 'compose' })
    if (focusAddress) {
      setAddressOpen(true)
      setTimeout(() => addressRef.current?.focus(), 50)
    }
  }

  const title = (
    <span className="flex items-center gap-2">
      <Megaphone className="size-6 text-brand-700" /> {t('report.title')}
    </span>
  )

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {phase.kind === 'compose' && (
        <div className="flex flex-col gap-4">
          <LocationChip
            state={geo.state}
            fix={geo.fix}
            typed={address.trim().length > 0}
            addressOpen={addressOpen}
            onRetry={() => { locatePromise.current = locate() }}
            onToggleAddress={() => {
              setAddressOpen((v) => !v)
              if (!addressOpen) setTimeout(() => addressRef.current?.focus(), 50)
            }}
          />
          {addressOpen && (
            <div className="relative">
              <MapPinned className="pointer-events-none absolute start-3.5 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
              <input
                ref={addressRef}
                type="text"
                dir="auto"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t('report.addressPlaceholder')}
                aria-label={t('report.addressLabel')}
                maxLength={200}
                enterKeyHint="done"
                autoComplete="street-address"
                className="min-h-12 w-full rounded-2xl border-2 border-slate-200 bg-white pe-4 ps-11 text-base outline-none focus:border-brand-600"
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('report.title')}>
            <InputTile icon={Mic} label={t('report.tileVoice')} active={panel === 'voice'} onClick={() => choosePanel('voice')}
              badge={rec.state === 'recording' ? 'rec' : rec.blob ? 'check' : null} addedLabel={t('report.added')} />
            <InputTile icon={Camera} label={t('report.tilePhoto')} active={panel === 'photo'} onClick={() => choosePanel('photo')}
              badge={photos.photos.length > 0 ? photos.photos.length : null} addedLabel={t('report.added')} />
            <InputTile icon={Keyboard} label={t('report.tileText')} active={panel === 'text'} onClick={() => choosePanel('text')}
              badge={hasText ? 'check' : null} addedLabel={t('report.added')} />
          </div>

          <div className="min-h-44">
            {panel === 'voice' && <VoicePanel rec={rec} />}
            {panel === 'photo' && <PhotoPanel draft={photos} autoOpen={autoCamera} onAutoOpened={onAutoOpened} />}
            {panel === 'text' && (
              <label className="block">
                <span className="sr-only">{t('report.textLabel')}</span>
                <textarea
                  ref={textRef}
                  dir="auto"
                  value={text}
                  onChange={(e) => { setText(e.target.value); setNeedInput(false) }}
                  placeholder={t('report.textPlaceholder')}
                  rows={5}
                  maxLength={1000}
                  className="w-full resize-none rounded-2xl border-2 border-slate-200 bg-white p-3 text-lg outline-none focus:border-brand-600"
                />
              </label>
            )}
          </div>

          <CategoryHints value={categoryHint} onChange={setCategoryHint} />

          <div className="sticky bottom-0 -mx-4 flex flex-col gap-1.5 bg-white px-4 pt-2 shadow-[0_-8px_12px_-8px_rgba(15,23,42,0.12)]">
            {(needInput || !hasInput) && (
              <p className={clsx('text-center text-sm', needInput ? 'font-semibold text-amber-700' : 'text-slate-500')}>{t('report.needInput')}</p>
            )}
            <button
              type="button"
              onClick={() => { void submit() }}
              disabled={!hasInput || photos.busy > 0}
              className="inline-flex min-h-16 items-center justify-center gap-3 rounded-2xl bg-brand-700 px-6 text-xl font-bold text-white shadow-lg transition active:scale-[0.98] disabled:bg-slate-300 disabled:shadow-none"
            >
              <Send className="size-7 rtl:-scale-x-100" />
              {t('report.send')}
              <span className="flex items-center gap-1 opacity-80" aria-hidden>
                {(rec.blob || rec.state === 'recording') && <Mic className="size-5" />}
                {photos.photos.length > 0 && <Camera className="size-5" />}
                {hasText && <Keyboard className="size-5" />}
              </span>
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'submitting' && <ProgressSteps steps={phase.steps} active={phase.active} />}

      {phase.kind === 'result' && (
        <ResultCard
          res={phase.res}
          onSeeMap={() => { resultSeen.current = true; onDone(phase.res) }}
          onNew={() => { resetDraft(); setPanel(mode); setPhase({ kind: 'compose' }) }}
        />
      )}

      {phase.kind === 'rejected' && (
        <StatusScreen icon={ShieldAlert} tone="amber" title={t('report.rejectedTitle')}
          body={pick(phase.rejected.message_en, phase.rejected.message_ur)}>
          <PrimaryButton icon={PencilLine} onClick={() => backToCompose()}>{t('report.editRetry')}</PrimaryButton>
          <SecondaryButton onClick={onClose}>{t('common.close')}</SecondaryButton>
        </StatusScreen>
      )}

      {phase.kind === 'needs_location' && (
        <StatusScreen icon={MapPinOff} tone="amber" title={t('report.needsLocTitle')} body={t('report.needsLocBody')}>
          {phase.hints.length > 0 && (
            <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm">
              <span className="text-slate-500">{t('report.weUnderstood')}</span>
              {phase.hints.map((h) => (
                <span key={h} dir="auto" className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">{h}</span>
              ))}
            </div>
          )}
          <PrimaryButton icon={MapPin} onClick={() => { void submit({ forceMap: true }) }}>{t('report.useMapCentre')}</PrimaryButton>
          <SecondaryButton icon={PencilLine} onClick={() => backToCompose(true)}>{t('report.typeAddress')}</SecondaryButton>
        </StatusScreen>
      )}

      {phase.kind === 'error' && (
        <ErrorScreen kind={phase.error} detail={phase.detail} onRetry={() => { void submit() }} onEdit={() => backToCompose()} />
      )}
    </Sheet>
  )
}

function InputTile({ icon: Icon, label, active, onClick, badge, addedLabel }: {
  icon: LucideIcon; label: string; active: boolean; onClick: () => void
  badge: 'check' | 'rec' | number | null; addedLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={badge ? `${label} — ${addedLabel}` : label}
      className={clsx(
        'relative flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border-2 font-bold transition active:scale-95',
        active ? 'border-brand-700 bg-brand-700 text-white shadow-md' : 'border-slate-200 bg-white text-ink',
      )}
    >
      <Icon className="size-8" />
      <span className="text-sm leading-tight">{label}</span>
      {badge === 'rec' && <span className="absolute end-2 top-2 size-3 animate-pulse rounded-full bg-red-500 ring-2 ring-white" />}
      {badge === 'check' && (
        <span className="absolute end-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-full bg-green-600 text-white ring-2 ring-white">
          <Check className="size-4" strokeWidth={3} />
        </span>
      )}
      {typeof badge === 'number' && (
        <span className="font-latin absolute end-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-full bg-green-600 text-xs text-white ring-2 ring-white">
          {badge}
        </span>
      )}
    </button>
  )
}

const TONES = {
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  slate: 'bg-slate-100 text-slate-600',
} as const

function StatusScreen({ icon: Icon, tone, title, body, children }: {
  icon: LucideIcon; tone: keyof typeof TONES; title: string; body?: string; children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center" role="alert">
      <span className={clsx('inline-flex size-20 items-center justify-center rounded-full', TONES[tone])}>
        <Icon className="size-10" />
      </span>
      <h3 className="text-xl font-bold">{title}</h3>
      {body && <p className="max-w-sm text-slate-700" dir="auto">{body}</p>}
      <div className="mt-2 flex w-full flex-col gap-2">{children}</div>
    </div>
  )
}

function PrimaryButton({ icon: Icon, onClick, children }: { icon: LucideIcon; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-700 px-5 text-lg font-bold text-white shadow-md active:scale-[0.98]">
      <Icon className="size-6" /> {children}
    </button>
  )
}

function SecondaryButton({ icon: Icon, onClick, children }: { icon?: LucideIcon; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 font-semibold text-ink active:scale-[0.98]">
      {Icon && <Icon className="size-5" />} {children}
    </button>
  )
}

function ErrorScreen({ kind, detail, onRetry, onEdit }: { kind: ErrKind; detail?: string; onRetry: () => void; onEdit: () => void }) {
  const { t } = useI18n()
  const view: Record<ErrKind, { icon: LucideIcon; tone: keyof typeof TONES; title: string; body: string }> = {
    offline: { icon: WifiOff, tone: 'slate', title: t('report.offlineTitle'), body: t('report.offlineBody') },
    network: { icon: CloudOff, tone: 'slate', title: t('report.networkTitle'), body: t('report.networkBody') },
    upload: { icon: CloudAlert, tone: 'amber', title: t('report.serverTitle'), body: t('report.uploadBody') },
    auth: { icon: LogIn, tone: 'amber', title: t('report.serverTitle'), body: t('report.authBody') },
    server: { icon: CircleAlert, tone: 'red', title: t('report.serverTitle'), body: t('report.serverBody') },
  }
  const v = view[kind]
  return (
    <StatusScreen icon={v.icon} tone={v.tone} title={v.title} body={v.body}>
      {kind === 'server' && detail && <p className="font-latin break-words text-xs text-slate-400" dir="auto">{detail}</p>}
      {kind !== 'auth' && <PrimaryButton icon={RotateCcw} onClick={onRetry}>{t('common.retry')}</PrimaryButton>}
      <SecondaryButton icon={PencilLine} onClick={onEdit}>{t('report.editReport')}</SecondaryButton>
    </StatusScreen>
  )
}
