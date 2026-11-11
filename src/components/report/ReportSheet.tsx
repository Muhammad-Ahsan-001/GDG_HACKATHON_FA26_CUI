import './report.css'
import clsx from 'clsx'
import {
  Camera, CircleAlert, CloudAlert, CloudOff, CloudUpload, Images, Loader2, LogIn, Megaphone, PencilLine, RotateCcw, ShieldAlert,
  WifiOff, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useGeolocation, type GeoFix } from '../../hooks/useGeolocation'
import { classifyTake, useRecorder, type TakeResult } from '../../hooks/useRecorder'
import { api, ApiError } from '../../lib/api'
import type { AttributeMap, ChatTurn, IntakeDraft, QuickReply, UserUrgency } from '../../lib/attributes'
import { translate, useI18n } from '../../lib/i18n'
import { MAX_PHOTOS, MediaUploadError, newClientId, uploadImage, uploadVoiceTurn } from '../../lib/media'
import { enqueue, useOfflineQueue, watchQueued, type QueueInput } from '../../lib/offlineQueue'
import type { ProcessReportRequest, ProcessReportResponse } from '../../lib/types'
import { VOICE_PROMPTS, buzz, playPrompt, playUrl, stopVoice, type VoicePromptId } from '../../lib/voice/player'
import { useOnline } from '../pwa/OfflineBanner'
import { Sheet } from '../ui'
import { VoiceGuide } from '../voice/VoiceGuide'
import { ChatThread, bubbleKey } from './ChatThread'
import { Composer, type Hint } from './Composer'
import { EmergencyCountdown } from './EmergencyCountdown'
import {
  asCategory, classifyError, hintsFromBody, isSendChip, isUserUrgency, msgId, sleep, urgencyAttribute,
  urgencyFromAttributes, type ErrKind, type Msg,
} from './intake'
import { KnowCard, UrgencyPicker } from './KnowCard'
import { LocationChip, type LocKind } from './LocationChip'
import { LocationStep, type PickedLoc } from './LocationStep'
import { OfflineCapture, QueuedCard, type OfflineLoc, type OfflineReason } from './OfflineCapture'
import { ProgressSteps, type StepKey } from './ProgressSteps'
import { ResultCard } from './ResultCard'
import { usePhotoDraft, type DraftPhoto } from './usePhotoDraft'

type Phase =
  | { kind: 'chat' }
  | { kind: 'location'; back: 'chat' | 'offline' }
  | { kind: 'submitting'; steps: StepKey[]; active: number }
  | { kind: 'result'; res: ProcessReportResponse; attributes: AttributeMap }
  | { kind: 'rejected'; rejected: NonNullable<ProcessReportResponse['rejected']> }
  | { kind: 'needs_location'; hints: string[] }
  | { kind: 'error'; error: ErrKind; detail?: string; note?: string; canQueue?: boolean }
  /** Phase 2: no connection (or the AI is down) — simple capture without the AI conversation, saved to the queue */
  | { kind: 'offline' }
  /** saved in the offline queue; turns into the normal result once the queue places it */
  | { kind: 'queued'; clientId: string; emergency: boolean; attributes: AttributeMap }

/** Location fields of a queued report (always a point: GPS, chosen spot or the map centre). */
type QueueLoc = Pick<ProcessReportRequest, 'lat' | 'lng' | 'accuracy_m' | 'location_source' | 'address_text'>

const backPhase = (b: 'chat' | 'offline'): Phase => (b === 'offline' ? { kind: 'offline' } : { kind: 'chat' })

/** One user turn before it is sent to report-chat (kept for retries). */
type TurnInput =
  | { kind: 'voice'; take: TakeResult; n?: number; path?: string; upload?: Promise<string> }
  | { kind: 'text'; text: string }
  | { kind: 'chip'; chip: QuickReply }

/** process-report request; the Phase-1b intake fields (conversation, attributes, user_urgency, ...) live in types.ts. */
type SubmitRequest = ProcessReportRequest

const TURN_MAX_MS = 90_000
/** answers to a follow-up ("haan", "nahi") are short; the first description needs >= 1 s of voice */
const FOLLOWUP_MIN_VOICED_MS = 400
/** emergencies: accept "Aag lagi hai!" */
const EMERGENCY_MIN_VOICED_MS = 300
const GPS_WAIT_MS = 4000
const HINT_MS = 9000
const MIN_TEXT = 2
/** How long each simulated step stays "running" while the single process-report request is in flight. */
const STEP_MS: Partial<Record<StepKey, number>> = { listen: 3500, understand: 4500, duplicates: 3000 }

const greeting = (): Msg => ({
  id: msgId('greet'), role: 'ai', kind: 'greeting',
  en: VOICE_PROMPTS.reportVoice.en, ur: VOICE_PROMPTS.reportVoice.ur, prompt: 'reportVoice',
})

/** Stable callback that always runs the latest closure (memoised children keep their props). */
function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => { ref.current = fn })
  return useCallback((...a: A) => ref.current(...a), [])
}

/**
 * The report flow as a short spoken conversation with the AI intake (report-chat), then process-report.
 * Props are the Phase-1 ones the MapPage uses.
 */
export function ReportSheet(props: {
  open: boolean
  mode: 'voice' | 'photo' | 'text'
  onClose: () => void
  mapCenter: { lat: number; lng: number }
  onDone: (res: ProcessReportResponse) => void
}) {
  const { open, mode, onClose, mapCenter, onDone } = props
  const { t, lang, pick } = useI18n()
  const photos = usePhotoDraft()
  const geo = useGeolocation()
  const onAutoStopRef = useRef<(r: TakeResult | null) => void>(() => undefined)
  const onAutoStop = useCallback((r: TakeResult | null) => onAutoStopRef.current(r), [])
  const rec = useRecorder({ maxMs: TURN_MAX_MS, onAutoStop })

  const [phase, setPhase] = useState<Phase>({ kind: 'chat' })
  const [msgs, setMsgs] = useState<Msg[]>(() => [greeting()])
  const [attributes, setAttributes] = useState<AttributeMap>({})
  const [knowVersion, setKnowVersion] = useState(0)
  const [draft, setDraft] = useState<IntakeDraft | null>(null)
  const [quick, setQuick] = useState<QuickReply[]>([])
  const [ready, setReady] = useState(false)
  const [askPhoto, setAskPhoto] = useState(false)
  const [photoWanted, setPhotoWanted] = useState(false)
  const [userUrgency, setUserUrgency] = useState<UserUrgency | null>(null)
  const [thinking, setThinking] = useState(false)
  const [countdown, setCountdown] = useState(false)
  const [sendQueued, setSendQueued] = useState(false)
  const [picked, setPicked] = useState<PickedLoc | null>(null)
  const [hint, setHint] = useState<Hint | null>(null)
  const [textOpen, setTextOpen] = useState(mode === 'text')
  const [text, setText] = useState('')
  // ---- offline capture (Phase 2)
  const online = useOnline()
  const queue = useOfflineQueue()
  const [offlineReason, setOfflineReason] = useState<OfflineReason>('offline')
  const [carried, setCarried] = useState(false)
  const [clip, setClip] = useState<{ take: TakeResult; url: string } | null>(null)
  const [offlineText, setOfflineText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ---- refs: the source of truth inside async flows ----
  const sessionRef = useRef(newClientId())
  const history = useRef<ChatTurn[]>([])
  const attrsRef = useRef<AttributeMap>({})
  const urgencyRef = useRef<UserUrgency | null>(null)
  const thinkingRef = useRef(false)
  const countdownRef = useRef(false)
  const countdownCancelled = useRef(false)
  const emergencyPending = useRef(false)
  const submitAfterTurn = useRef(false)
  const busy = useRef(false)
  const voiceSeq = useRef(0)
  const photoSeq = useRef(0)
  const photoHintShown = useRef(false)
  const audioPaths = useRef<string[]>([])
  const photoUploads = useRef(new Map<string, Promise<string>>())
  const photoDone = useRef(new Map<string, string>())
  const failedTurns = useRef(new Map<string, TurnInput>())
  /** emergency content captured before any conversation: sent straight to process-report */
  const direct = useRef<{ id: string; input: TurnInput } | null>(null)
  const pickedRef = useRef<PickedLoc | null>(null)
  const draftRef = useRef<IntakeDraft | null>(null)
  const draftVersion = useRef(0)
  /** last submit that failed in transit: retrying the SAME draft reuses its client_id (server is idempotent) */
  const attempt = useRef<{ clientId: string; version: number } | null>(null)
  const locatePromise = useRef<Promise<GeoFix | null> | null>(null)
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  const wasOpen = useRef(false)
  const openRef = useRef(open)
  const resultSeen = useRef(false)
  const phaseRef = useRef<Phase>(phase)
  const photosRef = useRef<DraftPhoto[]>(photos.photos)
  const geoRef = useRef(geo)
  const recStateRef = useRef(rec.state)
  const clipRef = useRef<{ take: TakeResult; url: string } | null>(null)
  const offlineTextRef = useRef('')
  const savingRef = useRef(false)
  /** consecutive report-chat server failures (2 => offer the offline capture: the AI is down) */
  const serverFails = useRef(0)
  const offlinePrompted = useRef(false)
  /** the last submit's idempotency key + location, for "save for later" after it failed in transit */
  const lastSubmit = useRef<{ clientId: string; loc: QueueLoc } | null>(null)

  useLayoutEffect(() => {
    phaseRef.current = phase
    photosRef.current = photos.photos
    geoRef.current = geo
    recStateRef.current = rec.state
  })

  const { reset: resetRecorder, finish: finishTake, start: startTake } = rec
  const { locate } = geo
  const clearPhotos = photos.clear
  const micBlocked = rec.state === 'denied' || rec.state === 'unsupported'

  // ---------------------------------------------------------------- helpers
  const appendMsg = (m: Msg) => setMsgs((prev) => [...prev, m])
  const updateMsg = (id: string, patch: Partial<Msg>) =>
    setMsgs((prev) => prev.map((m) => (m.id === id ? ({ ...m, ...patch } as Msg) : m)))

  const hasUserTurn = () => history.current.some((h) => h.role === 'user')
  const hasContent = () => hasUserTurn() || photosRef.current.length > 0 || direct.current !== null

  const lastNotice = useRef<{ prompt: VoicePromptId; at: number } | null>(null)
  const notice = (prompt: VoicePromptId, tone: Hint['tone'] = 'warn', sound = true) => {
    setHint({ prompt, tone })
    const now = Date.now()
    const repeat = lastNotice.current?.prompt === prompt && now - lastNotice.current.at < 1500
    lastNotice.current = { prompt, at: now }
    if (repeat) return // the same problem reported twice in a row (e.g. recorder error + its callback)
    if (sound && openRef.current) void playPrompt(prompt, lang)
    buzz([60, 80, 60])
  }

  const speak = (id: string, url: string | undefined, fallback?: VoicePromptId) => {
    if (!openRef.current || recStateRef.current === 'recording') return
    if (url) void playUrl(url, bubbleKey(id))
    else if (fallback) void playPrompt(fallback, lang)
  }

  const setUrgency = (u: UserUrgency | null) => {
    urgencyRef.current = u
    setUserUrgency(u)
    const next = { ...attrsRef.current }
    if (u) next.user_urgency = urgencyAttribute(u)
    else delete next.user_urgency
    attrsRef.current = next
    setAttributes(next)
    draftVersion.current++
  }

  const applyAttributes = (incoming: AttributeMap | undefined) => {
    const next: AttributeMap = { ...(incoming ?? attrsRef.current) }
    const u = urgencyRef.current
    if (u) next.user_urgency = urgencyAttribute(u) // the user's own choice always wins
    attrsRef.current = next
    setAttributes(next)
    setKnowVersion((v) => v + 1)
  }

  const currentPoint = (): { lat: number; lng: number } | null => {
    if (pickedRef.current) return pickedRef.current
    const g = geoRef.current
    return g.state === 'ok' && g.fix ? { lat: g.fix.lat, lng: g.fix.lng } : null
  }

  const ensurePhotoUpload = (p: DraftPhoto): Promise<string> => {
    let pr = photoUploads.current.get(p.id)
    if (!pr) {
      const sid = sessionRef.current
      pr = uploadImage(p.blob, sid, photoSeq.current++)
      photoUploads.current.set(p.id, pr)
      const mine = pr
      pr.then(
        (path) => { if (sessionRef.current === sid) photoDone.current.set(p.id, path) },
        () => { if (photoUploads.current.get(p.id) === mine) photoUploads.current.delete(p.id) },
      )
    }
    return pr
  }

  /** Paths of the current photos; `strict` waits for (and retries) every upload and throws on failure. */
  const photoPaths = async (strict: boolean): Promise<string[]> => {
    const list = photosRef.current
    if (!strict) return list.map((p) => photoDone.current.get(p.id)).filter((x): x is string => Boolean(x))
    return Promise.all(list.map((p) => ensurePhotoUpload(p)))
  }

  const voicePath = async (input: Extract<TurnInput, { kind: 'voice' }>): Promise<string> => {
    if (input.path) return input.path
    input.n ??= ++voiceSeq.current
    try {
      input.upload ??= uploadVoiceTurn(input.take.blob, input.take.mime, sessionRef.current, input.n)
      input.path = await input.upload
      return input.path
    } catch (e) {
      input.upload = undefined
      throw e
    }
  }

  const stopStepTimer = () => {
    if (stepTimer.current) clearTimeout(stepTimer.current)
    stepTimer.current = null
  }

  const runStepTimer = (steps: StepKey[], from: number) => {
    stopStepTimer()
    const schedule = (i: number) => {
      const ms = STEP_MS[steps[i]]
      if (i >= steps.length - 1 || !ms) return // last step keeps spinning until the response arrives
      stepTimer.current = setTimeout(() => {
        setPhase((p) => (p.kind === 'submitting' ? { ...p, active: Math.max(p.active, i + 1) } : p))
        schedule(i + 1)
      }, ms)
    }
    schedule(from)
  }

  const newSession = () => {
    sessionRef.current = newClientId()
    resetRecorder()
    clearPhotos()
    photosRef.current = []
    photoUploads.current.clear()
    photoDone.current.clear()
    history.current = []
    audioPaths.current = []
    failedTurns.current.clear()
    direct.current = null
    attrsRef.current = {}
    urgencyRef.current = null
    thinkingRef.current = false
    countdownRef.current = false
    countdownCancelled.current = false
    emergencyPending.current = false
    submitAfterTurn.current = false
    voiceSeq.current = 0
    photoSeq.current = 0
    photoHintShown.current = false
    pickedRef.current = null
    draftRef.current = null
    attempt.current = null
    draftVersion.current++
    setMsgs([greeting()])
    setAttributes({})
    setKnowVersion(0)
    setDraft(null)
    setQuick([])
    setReady(false)
    setAskPhoto(false)
    setPhotoWanted(false)
    setUserUrgency(null)
    setThinking(false)
    setCountdown(false)
    setSendQueued(false)
    setPicked(null)
    setHint(null)
    setText('')
    setClipTake(null)
    offlineTextRef.current = ''
    setOfflineText('')
    setSaveError(null)
    setCarried(false)
    serverFails.current = 0
    offlinePrompted.current = false
    lastSubmit.current = null
  }

  // ---------------------------------------------------------------- offline capture + queue (Phase 2)
  const setClipTake = (take: TakeResult | null) => {
    const prev = clipRef.current
    if (prev) { stopVoice(); URL.revokeObjectURL(prev.url) }
    const next = take ? { take, url: URL.createObjectURL(take.blob) } : null
    clipRef.current = next
    setClip(next)
  }

  /** Everything captured so far as one queue item (blobs that never reached Storage are uploaded at flush time). */
  const buildQueueItem = (clientId: string, loc: QueueLoc, extra: { clip?: TakeResult | null; text?: string } = {}): QueueInput => {
    const conversation = history.current
    const userTexts = conversation.filter((c) => c.role === 'user').map((c) => c.text.trim()).filter(Boolean)
    const d = direct.current?.input
    if (d?.kind === 'text') userTexts.push(d.text)
    const typed = extra.text?.trim()
    if (typed && typed.length >= MIN_TEXT) userTexts.push(typed)
    const attrs = attrsRef.current
    const directVoice = d?.kind === 'voice' ? d : null
    const newTake = extra.clip ?? (directVoice && !directVoice.path ? directVoice.take : null)
    const audio_path = !extra.clip && directVoice?.path ? directVoice.path : undefined
    // process-report transcribes `audio_path` only without a conversation: a new voice note next to an intake
    // conversation goes as voice + the conversation's words as text (+ attributes) instead
    const useConversation = conversation.length > 0 && !newTake && !audio_path
    const imagePaths: string[] = []
    const imageBlobs: Blob[] = []
    for (const ph of photosRef.current) {
      const path = photoDone.current.get(ph.id)
      if (path) imagePaths.push(path)
      else imageBlobs.push(ph.blob)
    }
    const knownAudio = [...audioPaths.current, ...(audio_path ? [audio_path] : [])]
    const category = asCategory(draftRef.current?.category)
    const landmark = attrs.landmark?.value_en?.trim()
    return {
      client_id: clientId,
      created_at: new Date().toISOString(),
      ui_language: lang,
      text: userTexts.join('\n') || undefined,
      ...(newTake ? { audio: { blob: newTake.blob, mime: newTake.mime } } : {}),
      audio_path,
      audio_paths: knownAudio.length ? knownAudio : undefined,
      images: imageBlobs.length ? imageBlobs : undefined,
      image_paths: imagePaths.length ? imagePaths : undefined,
      conversation: useConversation ? conversation : undefined,
      attributes: Object.keys(attrs).length ? attrs : undefined,
      user_urgency: urgencyRef.current ?? undefined,
      intake_session_id: sessionRef.current,
      category_hint: category && category !== 'other' ? category : undefined,
      ...loc,
      address_text: loc.address_text || landmark || undefined,
    }
  }

  /** Chosen spot > GPS (waits briefly while it is still locating) > the map centre. */
  const resolveQueueLoc = async (): Promise<QueueLoc> => {
    const chosen = pickedRef.current
    if (chosen) {
      return {
        lat: chosen.lat, lng: chosen.lng, location_source: chosen.source, address_text: chosen.label,
        ...(chosen.accuracy ? { accuracy_m: Math.round(chosen.accuracy) } : {}),
      }
    }
    const g = geoRef.current
    let fix: GeoFix | null = g.state === 'ok' ? g.fix : null
    if (!fix && g.state === 'locating' && locatePromise.current) {
      fix = await Promise.race([locatePromise.current, sleep(GPS_WAIT_MS).then(() => null)])
    }
    if (fix) return { lat: fix.lat, lng: fix.lng, accuracy_m: Math.round(fix.accuracy), location_source: 'gps' }
    return { lat: mapCenter.lat, lng: mapCenter.lng, location_source: 'map' }
  }

  const finishQueued = (clientId: string) => {
    const emergency = urgencyRef.current === 'emergency'
    const snapshot = attrsRef.current
    newSession()
    const next: Phase = { kind: 'queued', clientId, emergency, attributes: snapshot }
    phaseRef.current = next
    setPhase(next)
    void playPrompt('offlineQueued', lang)
    buzz([40, 60, 120])
  }

  /** Save the whole draft (conversation, voice, photos) for later, with the same client_id as the failed submit. */
  const queueDraft = async (c: { clientId: string; loc: QueueLoc }, kind: ErrKind): Promise<boolean> => {
    const loc: QueueLoc = c.loc.lat === undefined ? { ...c.loc, lat: mapCenter.lat, lng: mapCenter.lng, location_source: 'map' } : c.loc
    try {
      await enqueue(buildQueueItem(c.clientId, loc))
      finishQueued(c.clientId)
      return true
    } catch {
      setPhase({ kind: 'error', error: kind, note: t('alerts.offline_storageOff'), canQueue: false })
      void playPrompt('tryAgain', lang)
      return false
    }
  }

  /** Switch to the simple capture. A failed turn's voice / text (and an unsent emergency take) move into it. */
  const enterOffline = (reason: OfflineReason, carry?: TurnInput, failedId?: string) => {
    if (phaseRef.current.kind === 'offline') return
    stopVoice()
    stopStepTimer()
    countdownRef.current = false
    setCountdown(false)
    submitAfterTurn.current = false
    setSendQueued(false)
    emergencyPending.current = false
    const d = direct.current
    if (d) {
      direct.current = null
      setMsgs((prev) => prev.filter((m) => m.id !== d.id))
      carry ??= d.input
    }
    if (failedId) {
      failedTurns.current.delete(failedId)
      setMsgs((prev) => prev.filter((m) => m.id !== failedId))
    }
    if (carry?.kind === 'voice') setClipTake(carry.take)
    else if (carry?.kind === 'text') {
      const v = offlineTextRef.current || carry.text
      offlineTextRef.current = v
      setOfflineText(v)
    }
    setCarried(hasUserTurn())
    setOfflineReason(reason)
    setHint(null)
    setSaveError(null)
    const next: Phase = { kind: 'offline' }
    phaseRef.current = next
    setPhase(next)
    buzz([40, 60, 40])
    if (!offlinePrompted.current && openRef.current) {
      offlinePrompted.current = true
      void playPrompt('reportVoice', lang)
    }
  }
  const enterOfflineStable = useStable(enterOffline)

  /** A finished take in the offline capture: same silence checks as the conversation, then it becomes the voice note. */
  const onOfflineTake = (r: TakeResult | null) => {
    if (!r) { notice('tryAgain'); return }
    const verdict = classifyTake(r, { minVoicedMs: urgencyRef.current === 'emergency' ? EMERGENCY_MIN_VOICED_MS : undefined })
    if (verdict === 'silent') { notice('noSpeech'); return }
    if (verdict === 'too_short') { notice('tooShort'); return }
    setHint(null)
    setSaveError(null)
    setClipTake(r)
    buzz(25)
  }

  const onSaveOffline = useStable(async () => {
    if (savingRef.current) return
    if (recStateRef.current === 'recording') onTake(await finishTake()) // one tap: finish the take and save it
    const typed = offlineTextRef.current.trim()
    const has = Boolean(clipRef.current) || photosRef.current.length > 0 || typed.length >= MIN_TEXT || hasUserTurn()
    if (!has) {
      setSaveError(t('alerts.offline_needSomething'))
      buzz([60, 80, 60])
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    stopVoice()
    try {
      const loc = await resolveQueueLoc()
      const clientId = newClientId()
      await enqueue(buildQueueItem(clientId, loc, { clip: clipRef.current?.take, text: typed }))
      finishQueued(clientId)
    } catch {
      setSaveError(t('alerts.offline_saveFailed'))
      buzz([60, 80, 60])
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  })

  /** Back online in the capture: what was recorded / written becomes the first turn of the AI conversation. */
  const onTalkToAi = useStable(() => {
    const c = clipRef.current
    const typed = offlineTextRef.current.trim()
    if (c) URL.revokeObjectURL(c.url) // the blob itself stays valid for the upload
    clipRef.current = null
    setClip(null)
    offlineTextRef.current = ''
    setOfflineText('')
    serverFails.current = 0
    const next: Phase = { kind: 'chat' }
    phaseRef.current = next
    setPhase(next)
    if (c) void sendTurn({ kind: 'voice', take: c.take })
    else if (typed.length >= MIN_TEXT) void sendTurn({ kind: 'text', text: typed })
  })

  const onRemoveClip = useStable(() => setClipTake(null))
  const onOfflineText = useStable((v: string) => { offlineTextRef.current = v; setOfflineText(v); setSaveError(null) })
  const onOfflineUrgency = useStable((u: UserUrgency) => { setUrgency(u); buzz(25) })
  const onOfflineLocate = useStable(() => {
    pickedRef.current = null
    setPicked(null)
    draftVersion.current++
    void relocate()
  })

  // ---------------------------------------------------------------- countdown (emergency)
  const startCountdown = () => {
    if (countdownRef.current || busy.current || phaseRef.current.kind !== 'chat') return
    countdownRef.current = true
    setCountdown(true)
  }

  const cancelCountdown = () => {
    countdownRef.current = false
    countdownCancelled.current = true
    emergencyPending.current = false
    setCountdown(false)
    // what was captured for the direct emergency send becomes the first conversation turn
    const d = direct.current
    if (d) {
      direct.current = null
      if (d.input.kind === 'text' || d.input.kind === 'voice') void sendTurn(d.input, d.id)
    }
  }

  const onCountdownDone = () => {
    countdownRef.current = false
    setCountdown(false)
    void submit()
  }

  // ---------------------------------------------------------------- one conversation turn
  const sendTurn = async (input: TurnInput, retryId?: string) => {
    if (thinkingRef.current) return
    const sid = sessionRef.current
    const id = retryId ?? msgId('u')
    const label = input.kind === 'chip' ? pick(input.chip.label_en, input.chip.label_ur) : undefined
    if (retryId) updateMsg(id, { status: 'sending' })
    else if (input.kind === 'voice') appendMsg({ id, role: 'user', kind: 'voice', status: 'sending', durationMs: input.take.durationMs })
    else if (input.kind === 'text') appendMsg({ id, role: 'user', kind: 'text', status: 'sending', text: input.text })
    else appendMsg({ id, role: 'user', kind: 'chip', status: 'sending', chip: input.chip, text: label })
    const prevQuick = quick
    setQuick([])
    setHint(null)
    thinkingRef.current = true
    setThinking(true)
    draftVersion.current++
    try {
      const audio_path = input.kind === 'voice' ? await voicePath(input) : undefined
      const point = currentPoint()
      const image_paths = await photoPaths(false)
      const res = await api.reportChat({
        session_id: sid,
        ui_language: lang,
        history: history.current,
        attributes: attrsRef.current,
        audio_path,
        text: input.kind === 'text' ? input.text : undefined,
        quick_reply: input.kind === 'chip' ? { key: input.chip.key, value: input.chip.value } : undefined,
        image_paths: image_paths.length ? image_paths : undefined,
        lat: point?.lat,
        lng: point?.lng,
      })
      if (sessionRef.current !== sid) return
      failedTurns.current.delete(id)
      serverFails.current = 0

      if (res.no_speech) {
        updateMsg(id, { status: 'unheard' })
        const aiId = msgId('a')
        appendMsg({
          id: aiId, role: 'ai', kind: 'unheard',
          en: res.reply?.en || VOICE_PROMPTS.noSpeech.en, ur: res.reply?.ur || VOICE_PROMPTS.noSpeech.ur,
          audioUrl: res.reply_audio_url, prompt: 'noSpeech',
        })
        setQuick(prevQuick)
        buzz([60, 80, 60])
        speak(aiId, res.reply_audio_url, 'noSpeech')
        if (submitAfterTurn.current) {
          submitAfterTurn.current = false
          setSendQueued(false)
          if (hasContent()) queueMicrotask(() => { void submit() })
        }
        return
      }

      const at = new Date().toISOString()
      const userText = input.kind === 'voice' ? (res.transcript ?? '').trim() : input.kind === 'text' ? input.text : (label ?? input.chip.value)
      const turns: ChatTurn[] = [...history.current, { role: 'user', text: userText, at, ...(audio_path ? { audio_path } : {}) }]
      const replyText = pick(res.reply?.en, res.reply?.ur)
      if (replyText) {
        turns.push({
          role: 'ai', text: replyText, text_alt: (lang === 'ur' ? res.reply.en : res.reply.ur) || undefined, at,
          ...(res.reply_audio_url ? { audio_url: res.reply_audio_url } : {}),
        })
      }
      history.current = turns
      if (audio_path) audioPaths.current.push(audio_path)
      updateMsg(id, { status: 'done', text: userText || undefined })

      applyAttributes(res.attributes)
      draftRef.current = res.draft ?? null
      setDraft(draftRef.current)
      setReady(Boolean(res.ready))
      setAskPhoto(Boolean(res.ask_photo) && photosRef.current.length < MAX_PHOTOS)
      setQuick(Array.isArray(res.quick_replies) ? res.quick_replies.slice(0, 4) : [])
      if (!urgencyRef.current) {
        const u = urgencyFromAttributes(res.attributes ?? {})
        if (u) { urgencyRef.current = u; setUserUrgency(u) }
      }

      let aiId: string | null = null
      if (replyText) {
        aiId = msgId('a')
        appendMsg({ id: aiId, role: 'ai', kind: 'reply', en: res.reply.en, ur: res.reply.ur, audioUrl: res.reply_audio_url })
      }

      if (submitAfterTurn.current) {
        submitAfterTurn.current = false
        setSendQueued(false)
        queueMicrotask(() => { void submit() })
        return
      }
      if ((res.emergency || urgencyRef.current === 'emergency') && !countdownCancelled.current) startCountdown()
      if (aiId) speak(aiId, res.reply_audio_url)
    } catch (e) {
      if (sessionRef.current !== sid) return
      const kind = classifyError(e)
      failedTurns.current.set(id, input)
      updateMsg(id, { status: 'failed' })
      setQuick(prevQuick)
      if (submitAfterTurn.current) { submitAfterTurn.current = false; setSendQueued(false) }
      // no connection: keep what they said and switch to the simple capture (saved, sent when online)
      if (kind === 'offline' || kind === 'network') { enterOffline(kind, input, id); return }
      // the AI keeps failing (e.g. provider down): same simple capture, the queue keeps retrying
      if (kind === 'server' && ++serverFails.current >= 2) { enterOffline('server', input, id); return }
      notice('tryAgain')
    } finally {
      if (sessionRef.current === sid) {
        thinkingRef.current = false
        setThinking(false)
      }
    }
  }

  /** Emergency before any conversation: show the content, start the countdown, send it straight to process-report. */
  const startDirect = (input: TurnInput) => {
    const id = msgId('u')
    if (input.kind === 'voice') {
      void voicePath(input).catch(() => undefined) // upload during the countdown; submit retries on failure
      appendMsg({ id, role: 'user', kind: 'voice', status: 'done', durationMs: input.take.durationMs })
    } else if (input.kind === 'text') {
      appendMsg({ id, role: 'user', kind: 'text', status: 'done', text: input.text })
    } else return
    direct.current = { id, input }
    emergencyPending.current = false
    draftVersion.current++
    if (submitAfterTurn.current) {
      submitAfterTurn.current = false
      setSendQueued(false)
      void submit()
      return
    }
    startCountdown()
  }

  // ---------------------------------------------------------------- voice
  const onTake = (r: TakeResult | null, opts: { emergency?: boolean } = {}) => {
    resetRecorder() // the take now lives in the turn
    if (phaseRef.current.kind === 'offline') { onOfflineTake(r); return }
    const thenSubmit = submitAfterTurn.current
    const giveUpSubmit = () => {
      if (!thenSubmit) return
      submitAfterTurn.current = false
      setSendQueued(false)
      if (hasContent()) void submit()
    }
    if (!r) { notice('tryAgain'); giveUpSubmit(); return }
    const isDirect = (emergencyPending.current || opts.emergency) && history.current.length === 0 && !direct.current
    const minVoicedMs = isDirect || opts.emergency ? EMERGENCY_MIN_VOICED_MS : hasUserTurn() ? FOLLOWUP_MIN_VOICED_MS : undefined
    const verdict = classifyTake(r, { minVoicedMs })
    if (verdict === 'silent') { notice('noSpeech'); giveUpSubmit(); return }
    if (verdict === 'too_short') { notice('tooShort'); giveUpSubmit(); return }
    setHint(null)
    if (isDirect) { startDirect({ kind: 'voice', take: r }); return }
    void sendTurn({ kind: 'voice', take: r }) // urgency is 'emergency' now: the countdown starts after the AI heard it
  }
  useLayoutEffect(() => { onAutoStopRef.current = (r) => onTake(r) })

  const onMic = useStable(async () => {
    if (recStateRef.current === 'recording') { onTake(await finishTake()); return }
    if (thinkingRef.current || busy.current || countdownRef.current) return
    stopVoice() // never record the AI talking
    setHint(null)
    await startTake()
  })

  const onCancelRec = useStable(() => {
    resetRecorder()
    if (submitAfterTurn.current) { submitAfterTurn.current = false; setSendQueued(false) }
  })

  // ---------------------------------------------------------------- urgency, chips, text
  const chooseUrgency = (u: UserUrgency, chip?: QuickReply) => {
    setUrgency(u)
    buzz(25)
    if (u === 'emergency') {
      countdownCancelled.current = false
      if (recStateRef.current === 'recording') { void finishTake().then((r) => onTake(r, { emergency: true })); return }
      if (hasContent()) { startCountdown(); return }
      emergencyPending.current = true
      if (micBlocked) setTextOpen(true)
      else void onMic()
      return
    }
    emergencyPending.current = false
    if (chip && history.current.length > 0) void sendTurn({ kind: 'chip', chip })
  }
  const onPickUrgency = useStable((u: UserUrgency) => chooseUrgency(u))

  const onChip = useStable((q: QuickReply) => {
    if (isSendChip(q)) { void submit(); return }
    if (q.key === 'user_urgency' && isUserUrgency(q.value)) { chooseUrgency(q.value, q); return }
    void sendTurn({ kind: 'chip', chip: q })
  })

  const onSendText = useStable(() => {
    const v = text.trim()
    if (v.length < MIN_TEXT || thinkingRef.current) return
    setText('')
    if (emergencyPending.current && history.current.length === 0 && !direct.current) { startDirect({ kind: 'text', text: v }); return }
    void sendTurn({ kind: 'text', text: v })
  })

  const onRetry = useStable((id: string) => {
    const input = failedTurns.current.get(id)
    if (input) void sendTurn(input, id)
  })

  // ---------------------------------------------------------------- photos
  const openCamera = useStable(() => { stopVoice(); cameraInput.current?.click() })
  const openGallery = useStable(() => { stopVoice(); galleryInput.current?.click() })

  const onPhotoFiles = async (el: HTMLInputElement) => {
    const files = el.files ? Array.from(el.files) : []
    el.value = '' // allow picking the same file again after removing it
    if (!files.length) return
    const added = await photos.add(files)
    if (!added.length) return
    added.forEach((p) => { void ensurePhotoUpload(p).catch(() => undefined) })
    appendMsg({ id: msgId('p'), role: 'user', kind: 'photo', status: 'done', photoIds: added.map((p) => p.id) })
    setAskPhoto(false)
    setPhotoWanted(false)
    draftVersion.current++
    if (emergencyPending.current && history.current.length === 0) {
      emergencyPending.current = false
      startCountdown()
      return
    }
    if (!hasUserTurn() && !direct.current && !photoHintShown.current) {
      photoHintShown.current = true
      const id = msgId('a')
      appendMsg({ id, role: 'ai', kind: 'photo_hint', en: translate('en', 'report.photoHint'), ur: translate('ur', 'report.photoHint') })
    }
  }

  const onRemovePhoto = useStable((id: string) => {
    photos.remove(id)
    photoUploads.current.delete(id)
    photoDone.current.delete(id)
    draftVersion.current++
  })

  // ---------------------------------------------------------------- submit (process-report)
  const submit = async (opts: { loc?: PickedLoc } = {}) => {
    if (busy.current) return
    if (recStateRef.current === 'recording') {
      // one tap = finish the running take, let the AI hear it, then send
      submitAfterTurn.current = true
      setSendQueued(true)
      onTake(await finishTake())
      return
    }
    if (thinkingRef.current) { submitAfterTurn.current = true; setSendQueued(true); return }
    if (!hasContent()) return
    busy.current = true
    countdownRef.current = false
    submitAfterTurn.current = false
    setCountdown(false)
    setSendQueued(false)
    setHint(null)
    stopVoice()
    const d = direct.current?.input
    const directVoice = d?.kind === 'voice' && history.current.length === 0
    const steps: StepKey[] = ['upload', ...(directVoice ? (['listen'] as const) : []), 'understand', 'duplicates', 'pin']
    setPhase({ kind: 'submitting', steps, active: 0 })
    void playPrompt('reportSending', lang)
    let ctx: { clientId: string; loc: QueueLoc } | null = null

    try {
      // --- location: chosen spot > GPS > let the server geocode what was said (it answers needs_location if it can't)
      const chosen = opts.loc ?? pickedRef.current
      let fix: GeoFix | null = null
      if (!chosen) {
        const g = geoRef.current
        fix = g.state === 'ok' ? g.fix : null
        if (!fix && g.state === 'locating' && locatePromise.current) {
          fix = await Promise.race([locatePromise.current, sleep(GPS_WAIT_MS).then(() => null)])
        }
      }
      let loc: Pick<ProcessReportRequest, 'lat' | 'lng' | 'accuracy_m' | 'location_source'> = {}
      if (chosen) {
        loc = {
          lat: chosen.lat, lng: chosen.lng, location_source: chosen.source,
          ...(chosen.accuracy ? { accuracy_m: Math.round(chosen.accuracy) } : {}),
        }
      } else if (fix) {
        loc = { lat: fix.lat, lng: fix.lng, accuracy_m: Math.round(fix.accuracy), location_source: 'gps' }
      }

      // --- idempotency key: same draft => same client_id
      const version = draftVersion.current
      const clientId = attempt.current?.version === version ? attempt.current.clientId : newClientId()
      attempt.current = { clientId, version }
      ctx = { clientId, loc: { ...loc, address_text: chosen?.label } }
      lastSubmit.current = ctx

      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new MediaUploadError('network', 'offline')

      const [image_paths, direct_path] = await Promise.all([
        photoPaths(true),
        d?.kind === 'voice' ? voicePath(d) : Promise.resolve(undefined),
      ])

      setPhase((p) => (p.kind === 'submitting' ? { ...p, active: 1 } : p))
      runStepTimer(steps, 1)

      const conversation = history.current
      const userTexts = conversation.filter((c) => c.role === 'user').map((c) => c.text.trim()).filter(Boolean)
      if (d?.kind === 'text') userTexts.push(d.text)
      const attrs = attrsRef.current
      const allAudio = [...audioPaths.current, ...(direct_path ? [direct_path] : [])]
      const category = asCategory(draftRef.current?.category)
      const landmark = attrs.landmark?.value_en?.trim()
      const req: SubmitRequest = {
        client_id: clientId,
        ui_language: lang,
        language: 'auto',
        // the user's own words (transcripts + typed); the server builds its input from `conversation` when present
        text: userTexts.join('\n') || undefined,
        audio_path: conversation.length === 0 ? direct_path : undefined,
        audio_paths: allAudio.length ? allAudio : undefined,
        conversation: conversation.length ? conversation : undefined,
        attributes: Object.keys(attrs).length ? attrs : undefined,
        user_urgency: urgencyRef.current ?? undefined,
        intake_session_id: sessionRef.current,
        image_paths: image_paths.length ? image_paths : undefined,
        category_hint: category && category !== 'other' ? category : undefined,
        ...loc,
        address_text: chosen?.label || (loc.lat === undefined ? landmark : undefined) || undefined,
      }
      const res = await api.processReport(req)
      stopStepTimer()
      setPhase((p) => (p.kind === 'submitting' ? { ...p, active: p.steps.length } : p))
      await sleep(450) // let the last tick land

      attempt.current = null
      if (res.rejected) {
        if (res.rejected.reason === 'no_speech' && direct.current?.input.kind === 'voice') {
          updateMsg(direct.current.id, { status: 'unheard' })
          direct.current = null
        }
        setPhase({ kind: 'rejected', rejected: res.rejected })
        void playPrompt(res.rejected.reason === 'no_speech' ? 'noSpeech' : 'notIssue', lang)
      } else if (res.needs_location) {
        setPhase({ kind: 'needs_location', hints: res.needs_location.hints ?? [] })
        void playPrompt('needLocation', lang)
      } else {
        const snapshot = attrsRef.current
        newSession()
        resultSeen.current = openRef.current
        setPhase({ kind: 'result', res, attributes: snapshot })
        void playPrompt('reportDone', lang)
      }
    } catch (e) {
      stopStepTimer()
      if (e instanceof ApiError && e.code === 'needs_location') {
        attempt.current = null // nothing was stored: the next try gets a fresh client_id
        setPhase({ kind: 'needs_location', hints: hintsFromBody(e.body) })
        void playPrompt('needLocation', lang)
        return
      }
      const kind = classifyError(e)
      // OFFLINE_QUEUE_HOOK (Phase 2, wired): offline => save the whole draft to the IndexedDB queue right away
      // (same client_id; replayed on reconnect / Background Sync). Network / server / upload failures offer
      // "Save — send automatically" next to Try again.
      if (kind === 'offline' && ctx) { await queueDraft(ctx, kind); return }
      setPhase({ kind: 'error', error: kind, detail: e instanceof Error ? e.message : undefined, canQueue: kind !== 'auth' && ctx !== null })
      void playPrompt('tryAgain', lang)
    } finally {
      busy.current = false
    }
  }
  const onSend = useStable(() => { void submit() })

  // ---------------------------------------------------------------- location
  const openLocation = useStable(() => {
    if (recStateRef.current === 'recording') return
    stopVoice()
    setPhase({ kind: 'location', back: phaseRef.current.kind === 'offline' ? 'offline' : 'chat' })
  })

  const choosePoint = (p: PickedLoc) => {
    pickedRef.current = p
    setPicked(p)
    draftVersion.current++
  }

  const locationInitial = (): PickedLoc => {
    if (pickedRef.current) return pickedRef.current
    const g = geoRef.current
    if (g.state === 'ok' && g.fix) return { lat: g.fix.lat, lng: g.fix.lng, source: 'gps', accuracy: g.fix.accuracy }
    return { lat: mapCenter.lat, lng: mapCenter.lng, source: 'map' }
  }

  const relocate = useCallback(() => {
    const pr = locate()
    locatePromise.current = pr
    return pr
  }, [locate])

  // ---------------------------------------------------------------- open / close / mode
  const applyMode = (m: 'voice' | 'photo' | 'text') => {
    if (m === 'text') { setTextOpen(true); return }
    setTextOpen(false)
    if (m === 'photo' && photosRef.current.length === 0) {
      setPhotoWanted(true)
      // best effort: browsers may require a fresh tap, in which case the big camera tile is right there
      try { cameraInput.current?.click() } catch { /* blocked without user activation */ }
    }
  }
  const applyModeStable = useStable(applyMode)
  const onCloseCleanup = useStable(() => {
    resetRecorder()
    stopVoice()
    if (countdownRef.current) cancelCountdown()
    if (submitAfterTurn.current && !thinkingRef.current) { submitAfterTurn.current = false; setSendQueued(false) }
    setHint(null)
  })
  const onOpenInit = useStable(() => {
    if (phaseRef.current.kind === 'result') {
      if (resultSeen.current) setPhase({ kind: 'chat' }) // the session was already reset when it succeeded
      else resultSeen.current = true // finished while the sheet was closed: show it now
    }
    const cur = phaseRef.current
    if (cur.kind === 'location') setPhase(backPhase(cur.back))
    if (cur.kind === 'queued') setPhase({ kind: 'chat' }) // the queue / banner carries on from here
    if (!pickedRef.current) void relocate()
    if (recStateRef.current === 'unsupported') setHint({ prompt: 'micDenied', tone: 'info' })
  })

  const lastMode = useRef(mode)
  useEffect(() => {
    openRef.current = open
    if (open && !wasOpen.current) {
      onOpenInit()
      applyModeStable(mode)
      lastMode.current = mode
    }
    if (!open && wasOpen.current) onCloseCleanup()
    wasOpen.current = open
  }, [open, mode, onOpenInit, applyModeStable, onCloseCleanup])

  // the map may switch the mode while the sheet is already open
  useEffect(() => {
    if (open && lastMode.current !== mode) applyModeStable(mode)
    lastMode.current = mode
  }, [open, mode, applyModeStable])

  // microphone refused / broken: say so and offer photo + text
  useEffect(() => {
    if (!openRef.current) return
    if (rec.state === 'denied') { setTextOpen(false); notice('micDenied') }
    else if (rec.state === 'error') notice('tryAgain')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.state])

  // transient hints fade out (the mic-denied one stays while it is true)
  useEffect(() => {
    if (!hint || hint.prompt === 'micDenied') return
    const id = setTimeout(() => setHint(null), HINT_MS)
    return () => clearTimeout(id)
  }, [hint])

  useEffect(() => () => {
    stopStepTimer()
    if (clipRef.current) URL.revokeObjectURL(clipRef.current.url)
  }, [])

  // no connection while the conversation is idle: switch to the simple offline capture
  useEffect(() => {
    if (!open || online || phase.kind !== 'chat') return
    if (recStateRef.current === 'recording' || thinkingRef.current || busy.current || countdownRef.current) return
    enterOfflineStable('offline')
  }, [open, online, phase.kind, enterOfflineStable])

  // back online with nothing captured yet: straight back to the AI conversation
  useEffect(() => {
    if (!open || !online || phase.kind !== 'offline' || offlineReason !== 'offline') return
    if (clipRef.current || photosRef.current.length || offlineTextRef.current.trim() || recStateRef.current === 'recording') return
    const next: Phase = { kind: 'chat' }
    phaseRef.current = next
    setPhase(next)
  }, [open, online, phase.kind, offlineReason])

  // the "saved" card is on screen: no toast for it, and speak the outcome when the queue sends it
  const queuedId = phase.kind === 'queued' ? phase.clientId : null
  const queuedOutcome = queuedId ? queue.outcomes[queuedId] : undefined
  useEffect(() => (open && queuedId ? watchQueued(queuedId) : undefined), [open, queuedId])
  const outcomeKind = queuedOutcome?.kind
  useEffect(() => {
    if (!outcomeKind || !openRef.current) return
    void playPrompt(outcomeKind === 'placed' ? 'reportDone' : outcomeKind === 'rejected' ? 'notIssue' : 'tryAgain', lang)
    buzz(outcomeKind === 'placed' ? [60, 60, 120] : [60, 80, 60])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeKind])

  // ---------------------------------------------------------------- render
  const canSend = phase.kind === 'chat' && (
    msgs.some((m) => m.role === 'user' && m.kind !== 'photo' && m.status === 'done') || photos.photos.length > 0
  )
  const firstTurn = !msgs.some((m) => m.role === 'ai' && m.kind === 'reply')
  const geoFix = geo.state === 'ok' ? geo.fix : null
  const locKind: LocKind = picked ? 'picked' : geo.state === 'locating' ? 'locating' : geoFix ? 'gps' : 'none'
  const userLoc = useMemo(() => (geoFix ? { lat: geoFix.lat, lng: geoFix.lng } : null), [geoFix])
  const roomForPhotos = photos.photos.length < photos.max
  const offLoc: OfflineLoc = picked ? { kind: 'picked', label: picked.label }
    : geo.state === 'locating' ? { kind: 'locating' }
      : geoFix ? { kind: 'gps', accuracy: geoFix.accuracy } : { kind: 'map' }
  const canSaveOffline = Boolean(clip) || photos.photos.length > 0 || offlineText.trim().length >= MIN_TEXT || carried
  const showPhotoCard = phase.kind === 'chat' && photoWanted && firstTurn && roomForPhotos
  const showPhotoAsk = phase.kind === 'chat' && askPhoto && !firstTurn && roomForPhotos

  const lastAiExtra = useMemo(
    () => (showPhotoAsk ? <PhotoAsk onCamera={openCamera} onGallery={openGallery} /> : null),
    [showPhotoAsk, openCamera, openGallery],
  )
  const afterGreeting = useMemo(
    () => (firstTurn ? <UrgencyPicker value={userUrgency} onPick={onPickUrgency} /> : null),
    [firstTurn, userUrgency, onPickUrgency],
  )
  const footer = useMemo(() => {
    if (!showPhotoCard && photos.busy === 0 && !photos.error) return null
    return (
      <div className="flex flex-col gap-2">
        {showPhotoCard && <PhotoCard onCamera={openCamera} onGallery={openGallery} autoPlay={photoWanted} />}
        {photos.busy > 0 && (
          <div className="flex items-center gap-2 self-end rounded-full bg-slate-100 px-3 py-2 text-sm text-slate-600">
            <Loader2 className="size-4 animate-spin" /> {t('report.preparingPhoto')}
          </div>
        )}
        {photos.error && (
          <p role="alert" className="self-end rounded-2xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            {photos.error === 'too_large' ? t('report.photoTooLarge') : t('report.photoDecodeError')}
          </p>
        )}
      </div>
    )
  }, [showPhotoCard, photos.busy, photos.error, photoWanted, openCamera, openGallery, t])

  const guidePrompt: VoicePromptId | null = phase.kind === 'chat' || phase.kind === 'offline'
    ? (micBlocked ? 'micDenied' : 'reportVoice')
    : phase.kind === 'queued' ? (outcomeKind === 'placed' ? 'reportDone' : 'offlineQueued')
    : phase.kind === 'result' ? 'reportDone'
      : phase.kind === 'rejected' ? (phase.rejected.reason === 'no_speech' ? 'noSpeech' : 'notIssue')
        : phase.kind === 'error' ? 'tryAgain' : null

  const title = (
    <span className="flex items-center gap-2">
      <Megaphone className="size-6 shrink-0 text-brand-700" />
      <span className="min-w-0 flex-1 truncate">{t('report.title')}</span>
      {guidePrompt && (
        <VoiceGuide prompt={guidePrompt} autoPlay={guidePrompt === 'reportVoice' && mode !== 'photo'} label={false} size={40} />
      )}
    </span>
  )

  const wrap = (node: ReactNode) => <div className="awaaz-chat-scroll -mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-2">{node}</div>

  return (
    <Sheet open={open} onClose={onClose} title={title} className="flex h-[92dvh] flex-col overflow-hidden! md:h-auto">
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { void onPhotoFiles(e.currentTarget) }} />
      <input ref={galleryInput} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => { void onPhotoFiles(e.currentTarget) }} />

      {phase.kind === 'chat' && (
        <>
          <div className="flex shrink-0 flex-col gap-2 pb-2">
            <LocationChip kind={locKind} accuracy={geoFix?.accuracy} label={picked?.label} onOpen={openLocation} />
            <KnowCard draft={draft} attributes={attributes} version={knowVersion} />
          </div>
          <ChatThread
            msgs={msgs}
            thinking={thinking}
            photos={photos.photos}
            onRemovePhoto={onRemovePhoto}
            onRetry={onRetry}
            afterGreeting={afterGreeting}
            lastAiExtra={lastAiExtra}
            footer={footer}
          />
          {countdown ? (
            <EmergencyCountdown onElapsed={onCountdownDone} onCancel={cancelCountdown} />
          ) : (
            <Composer
              rec={rec}
              micBlocked={micBlocked}
              thinking={thinking}
              quick={quick}
              onChip={onChip}
              onMic={onMic}
              onCancelRec={onCancelRec}
              onCamera={openCamera}
              photoCount={photos.photos.length}
              askPhoto={askPhoto}
              textOpen={textOpen}
              onTextOpen={setTextOpen}
              text={text}
              onText={setText}
              onSendText={onSendText}
              canSend={canSend}
              ready={ready}
              emergency={userUrgency === 'emergency'}
              sendQueued={sendQueued}
              onSend={onSend}
              hint={hint}
              onDismissHint={() => setHint(null)}
            />
          )}
        </>
      )}

      {phase.kind === 'location' && (
        <LocationStep
          initial={locationInitial()}
          userLocation={userLoc}
          onLocate={relocate}
          onBack={() => setPhase(backPhase(phase.back))}
          onUse={(p) => { choosePoint(p); setPhase(backPhase(phase.back)) }}
        />
      )}

      {phase.kind === 'offline' && (
        <OfflineCapture
          reason={offlineReason}
          online={online}
          carried={carried}
          preferWrite={textOpen}
          rec={rec}
          micBlocked={micBlocked}
          clip={clip ? { url: clip.url, durationMs: clip.take.durationMs } : null}
          onMic={onMic}
          onCancelRec={onCancelRec}
          onRemoveClip={onRemoveClip}
          photos={photos.photos}
          photoBusy={photos.busy}
          photoError={photos.error ? (photos.error === 'too_large' ? t('report.photoTooLarge') : t('report.photoDecodeError')) : null}
          roomForPhotos={roomForPhotos}
          onCamera={openCamera}
          onGallery={openGallery}
          onRemovePhoto={onRemovePhoto}
          urgency={userUrgency}
          onUrgency={onOfflineUrgency}
          text={offlineText}
          onText={onOfflineText}
          loc={offLoc}
          onLocate={onOfflineLocate}
          onChooseMap={openLocation}
          hint={hint}
          onDismissHint={() => setHint(null)}
          saving={saving}
          saveError={saveError}
          canSave={canSaveOffline}
          onSave={onSaveOffline}
          onTalkToAi={onTalkToAi}
        />
      )}

      {phase.kind === 'queued' && (queuedOutcome?.kind === 'placed'
        ? wrap(
          <ResultCard
            res={queuedOutcome.res}
            attributes={phase.attributes}
            onSeeMap={() => onDone(queuedOutcome.res)}
            onNew={() => { setPhase({ kind: 'chat' }); applyMode(mode) }}
          />,
        )
        : wrap(
          <QueuedCard
            clientId={phase.clientId}
            emergency={phase.emergency}
            outcome={queuedOutcome}
            onNew={() => { setPhase({ kind: 'chat' }); applyMode(mode) }}
            onClose={onClose}
          />,
        ))}

      {phase.kind === 'needs_location' && (
        <LocationStep
          problem
          initial={locationInitial()}
          userLocation={userLoc}
          hints={phase.hints}
          onLocate={relocate}
          onBack={() => setPhase({ kind: 'chat' })}
          onUse={(p) => { choosePoint(p); setPhase({ kind: 'chat' }); void submit({ loc: p }) }}
        />
      )}

      {phase.kind === 'submitting' && wrap(<ProgressSteps steps={phase.steps} active={phase.active} />)}

      {phase.kind === 'result' && wrap(
        <ResultCard
          res={phase.res}
          attributes={phase.attributes}
          onSeeMap={() => { resultSeen.current = true; onDone(phase.res) }}
          onNew={() => { newSession(); setPhase({ kind: 'chat' }); applyMode(mode) }}
        />,
      )}

      {phase.kind === 'rejected' && wrap(
        <StatusScreen icon={ShieldAlert} tone="amber" title={t('report.rejectedTitle')}
          body={pick(phase.rejected.message_en, phase.rejected.message_ur)}>
          <PrimaryButton icon={PencilLine} onClick={() => setPhase({ kind: 'chat' })}>{t('report.editRetry')}</PrimaryButton>
          <SecondaryButton onClick={onClose}>{t('common.close')}</SecondaryButton>
        </StatusScreen>,
      )}

      {phase.kind === 'error' && wrap(
        <ErrorScreen
          kind={phase.error}
          detail={phase.detail}
          note={phase.note}
          onRetry={() => { void submit() }}
          onEdit={() => setPhase({ kind: 'chat' })}
          onSaveLater={phase.canQueue ? () => {
            const c = lastSubmit.current
            if (c) void queueDraft(c, phase.error)
          } : undefined}
        />,
      )}
    </Sheet>
  )
}

function PhotoCard({ onCamera, onGallery, autoPlay }: { onCamera: () => void; onGallery: () => void; autoPlay: boolean }) {
  const { t } = useI18n()
  return (
    <div className="awaaz-bubble-in ms-11 flex flex-col gap-2.5 rounded-3xl bg-white p-3 shadow-sm ring-1 ring-brand-100">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-semibold text-slate-700">{t('report.photoCardBody')}</span>
        <VoiceGuide prompt="reportPhoto" autoPlay={autoPlay} label={false} size={40} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCamera}
          className="relative inline-flex min-h-16 flex-1 items-center justify-center gap-3 rounded-2xl bg-brand-700 px-4 text-lg font-bold text-white shadow-md active:scale-[0.98]"
        >
          <span aria-hidden className="awaaz-attn absolute inset-0 rounded-2xl ring-4 ring-brand-500/40" />
          <Camera className="relative size-8" /> <span className="relative">{t('report.takePhoto')}</span>
        </button>
        <button
          type="button"
          onClick={onGallery}
          aria-label={t('report.fromGallery')}
          className="inline-flex min-h-16 w-20 flex-col items-center justify-center gap-0.5 rounded-2xl bg-slate-50 text-xs font-semibold text-ink ring-1 ring-slate-200 active:scale-[0.98]"
        >
          <Images className="size-7" /> {t('report.fromGallery')}
        </button>
      </div>
    </div>
  )
}

/** Inline "take a photo" row inside the AI bubble that asked for one. */
function PhotoAsk({ onCamera, onGallery }: { onCamera: () => void; onGallery: () => void }) {
  const { t } = useI18n()
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-brand-100 pt-3">
      <button
        type="button"
        onClick={onCamera}
        className="relative inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-700 px-3 text-base font-bold text-white shadow-md active:scale-[0.98]"
      >
        <span aria-hidden className="awaaz-attn absolute inset-0 rounded-2xl ring-4 ring-brand-500/40" />
        <Camera className="relative size-6" /> <span className="relative">{t('report.takePhoto')}</span>
      </button>
      <button
        type="button"
        onClick={onGallery}
        aria-label={t('report.fromGallery')}
        title={t('report.fromGallery')}
        className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-white text-ink ring-1 ring-slate-200 active:scale-95"
      >
        <Images className="size-6" />
      </button>
      <VoiceGuide prompt="reportPhoto" label={false} size={40} />
    </div>
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

function ErrorScreen({ kind, detail, note, onRetry, onEdit, onSaveLater }: {
  kind: ErrKind; detail?: string; note?: string; onRetry: () => void; onEdit: () => void; onSaveLater?: () => void
}) {
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
      {note && <p className="rounded-2xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">{note}</p>}
      {kind === 'server' && detail && <p className="font-latin break-words text-xs text-slate-400" dir="auto">{detail}</p>}
      {/* Phase 2: the report goes to the offline queue (same client_id) and is sent automatically */}
      {onSaveLater && <PrimaryButton icon={CloudUpload} onClick={onSaveLater}>{t('alerts.offline_saveLater')}</PrimaryButton>}
      {kind !== 'auth' && (onSaveLater
        ? <SecondaryButton icon={RotateCcw} onClick={onRetry}>{t('alerts.offline_retryNow')}</SecondaryButton>
        : <PrimaryButton icon={RotateCcw} onClick={onRetry}>{t('common.retry')}</PrimaryButton>)}
      <SecondaryButton icon={PencilLine} onClick={onEdit}>{t('report.editReport')}</SecondaryButton>
    </StatusScreen>
  )
}
