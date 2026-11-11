// Offline report queue (Phase 2). Reports captured without internet (or whose final submit failed in transit) are kept
// in IndexedDB (idb-keyval, own database 'awaaz-queue') with their audio / photo blobs, and replayed to process-report
// when the connection returns: on the 'online' event, on app start when signed in, when the page becomes visible, and
// when the service worker's Background Sync fires (src/sw.ts posts {type:'awaaz-sync'}; uploads need the page's auth
// session, so the page does the actual flush).
// Each item keeps its client_id: process-report is idempotent on (reporter, client_id), so a replay after a lost
// response returns the stored report instead of creating a second one.
import { CloudCheck, CloudOff, ShieldAlert } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { toast } from '../components/pwa/toast'
import { api, ApiError } from './api'
import type { AttributeMap, ChatTurn, UserUrgency } from './attributes'
import { translate } from './i18n'
import { MediaUploadError, uploadAudio, uploadImages } from './media'
import { STATUS_META } from './status'
import { supabase } from './supabase'
import type { Category, Lang, ProcessReportRequest, ProcessReportResponse } from './types'
import { createStore, del, entries, set, type UseStore } from 'idb-keyval'

export const SYNC_TAG = 'awaaz-report-sync'
export const SYNC_MESSAGE = 'awaaz-sync'

/** What the report sheet hands over. Blobs are uploaded at flush time; *_path(s) were already uploaded. */
export interface QueueInput {
  client_id: string
  created_at: string
  ui_language: Lang
  text?: string
  /** voice note not uploaded yet → report-audio/<uid>/<client_id>.<ext> */
  audio?: { blob: Blob; mime: string }
  /** compressed JPEGs not uploaded yet → report-images/<client_id>/<n>.jpg */
  images?: Blob[]
  lat?: number
  lng?: number
  accuracy_m?: number
  location_source?: 'gps' | 'map' | 'geocoded'
  address_text?: string
  user_urgency?: UserUrgency
  attributes?: AttributeMap
  /** intake conversation so far (sent as `conversation`: the server then builds its input from the turns) */
  conversation?: ChatTurn[]
  /** already uploaded during an online conversation */
  audio_path?: string
  audio_paths?: string[]
  image_paths?: string[]
  intake_session_id?: string
  category_hint?: Category
}

/** A blob as stored: Blob where IndexedDB accepts it, raw bytes on engines that refuse Blobs (old WebViews). */
type StoredBlob = Blob | { buf: ArrayBuffer; type: string }

interface StoredItem extends Omit<QueueInput, 'audio' | 'images'> {
  v: 1
  /** account that captured it: uploads go to that user's folder, so only that session may send it */
  uid?: string
  audio?: { blob: StoredBlob; mime: string }
  images?: StoredBlob[]
  attempts: number
  last_error?: string
  last_try_at?: string
}

export type ItemOutcome =
  | { kind: 'placed'; res: ProcessReportResponse }
  | { kind: 'rejected'; res: ProcessReportResponse }
  | { kind: 'dropped'; error: string }

export interface QueueSnapshot {
  /** client_ids waiting, oldest first */
  ids: string[]
  count: number
  /** a flush is running */
  flushing: boolean
  /** client_id being sent right now */
  current: string | null
  /** why the last flush stopped early (items kept) */
  error: 'network' | 'server' | 'auth' | null
  /** last flush that placed / dropped something (for the banner's success flash) */
  last: { placed: number; dropped: number; at: number } | null
  /** recent outcomes per client_id (the report sheet's "saved" card turns into the result) */
  outcomes: Record<string, ItemOutcome>
  /** IndexedDB could not be opened (private window / blocked storage) */
  unavailable: boolean
}

// ---------------------------------------------------------------- store

let idb: UseStore | null = null
function db(): UseStore {
  idb ??= createStore('awaaz-queue', 'reports')
  return idb
}

let snap: QueueSnapshot = {
  ids: [], count: 0, flushing: false, current: null, error: null, last: null, outcomes: {}, unavailable: false,
}
const listeners = new Set<() => void>()
function patch(next: Partial<QueueSnapshot>) {
  snap = { ...snap, ...next }
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}
const getSnapshot = () => snap

/** Live queue state for UI (count, flushing, outcomes). */
export function useOfflineQueue(): QueueSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
export function getQueueSnapshot(): QueueSnapshot {
  return snap
}

/** client_ids whose outcome a screen is already showing (no toast for those). */
const watched = new Set<string>()
export function watchQueued(clientId: string): () => void {
  watched.add(clientId)
  return () => { watched.delete(clientId) }
}

function toStorable(b: Blob): Promise<StoredBlob> {
  return b.arrayBuffer().then((buf) => ({ buf, type: b.type }))
}
function asBlob(s: StoredBlob): Blob {
  return s instanceof Blob ? s : new Blob([s.buf], { type: s.type })
}

async function put(item: StoredItem): Promise<void> {
  try {
    await set(item.client_id, item, db())
  } catch (e) {
    // DataCloneError: this engine cannot store Blobs in IndexedDB — store the bytes instead
    if (!(e instanceof DOMException && e.name === 'DataCloneError')) throw e
    const copy: StoredItem = { ...item }
    if (item.audio) copy.audio = { mime: item.audio.mime, blob: item.audio.blob instanceof Blob ? await toStorable(item.audio.blob) : item.audio.blob }
    if (item.images) copy.images = await Promise.all(item.images.map((b) => (b instanceof Blob ? toStorable(b) : b)))
    await set(item.client_id, copy, db())
  }
}

async function readAll(): Promise<StoredItem[]> {
  const rows = await entries<string, StoredItem>(db())
  return rows.map(([, v]) => v).filter((v): v is StoredItem => Boolean(v && v.client_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

async function refresh(): Promise<StoredItem[]> {
  try {
    const items = await readAll()
    patch({ ids: items.map((i) => i.client_id), count: items.length, unavailable: false })
    return items
  } catch {
    patch({ unavailable: true })
    return []
  }
}

async function currentUid(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession()
    return data.session?.user.id ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- public API

/** Save a report for later; resolves with the number of reports waiting. Throws when the device cannot store it. */
export async function enqueue(input: QueueInput): Promise<number> {
  const uid = await currentUid()
  const { audio, images, ...rest } = input
  const item: StoredItem = {
    ...rest,
    v: 1,
    ...(uid ? { uid } : {}),
    ...(audio ? { audio: { blob: audio.blob, mime: audio.mime } } : {}),
    ...(images?.length ? { images } : {}),
    attempts: 0,
  }
  await put(item)
  const items = await refresh()
  backoff = 0
  void registerBackgroundSync()
  // the connection may be fine (the AI or the server failed): try again shortly
  if (isOnline()) scheduleRetry(4000)
  return items.length
}

/** Waiting reports, oldest first (blobs omitted). */
export async function list(): Promise<Omit<StoredItem, 'audio' | 'images'>[]> {
  const items = await readAll()
  return items.map((i) => {
    const r = { ...i }
    delete r.audio
    delete r.images
    return r
  })
}

export async function count(): Promise<number> {
  return (await refresh()).length
}

export async function remove(clientId: string): Promise<void> {
  await del(clientId, db())
  await refresh()
}

// ---------------------------------------------------------------- flush

type Verdict = 'network' | 'auth' | 'transient' | 'permanent'

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

function classify(e: unknown): Verdict {
  if (!isOnline()) return 'network'
  if (e instanceof MediaUploadError) {
    if (e.code === 'network') return 'network'
    if (e.code === 'auth') return 'auth'
    return 'transient' // storage refused it (quota / policy blip): keep, the attempt cap decides
  }
  if (e instanceof ApiError) {
    // FunctionsFetchError / FunctionsRelayError: no HTTP response reached us
    if (e.body === undefined && /send a request|fetch|network|relay|load failed/i.test(e.message)) return 'network'
    if (e.status === 401) return 'auth'
    if (e.status === 408 || e.status === 425 || e.status === 429) return 'transient'
    if (e.status >= 400 && e.status < 500) return 'permanent'
    return 'transient'
  }
  if (e instanceof TypeError) return 'network'
  return 'transient'
}

/** Storage refusals are kept a few times only (a 5xx from the server is kept forever: the AI may be down for a while). */
const MAX_UPLOAD_FAILURES = 6

/** Upload the blobs (persisting progress so a later retry does not re-upload) and build the process-report request. */
async function prepare(item: StoredItem): Promise<ProcessReportRequest> {
  if (item.audio) {
    const path = await uploadAudio(asBlob(item.audio.blob), item.audio.mime, item.client_id)
    item.audio_path = path
    item.audio_paths = [...new Set([...(item.audio_paths ?? []), path])]
    delete item.audio
    await put(item)
  }
  if (item.images?.length) {
    const paths = await uploadImages(item.images.map(asBlob), item.client_id)
    item.image_paths = [...new Set([...(item.image_paths ?? []), ...paths])]
    delete item.images
    await put(item)
  }
  const conversation = item.conversation?.length ? item.conversation : undefined
  return {
    client_id: item.client_id,
    ui_language: item.ui_language,
    language: 'auto',
    text: item.text || undefined,
    // with a conversation the server builds its input from the turns and never re-transcribes
    audio_path: conversation ? undefined : item.audio_path,
    audio_paths: item.audio_paths?.length ? item.audio_paths : undefined,
    conversation,
    attributes: item.attributes && Object.keys(item.attributes).length ? item.attributes : undefined,
    user_urgency: item.user_urgency,
    intake_session_id: item.intake_session_id,
    image_paths: item.image_paths?.length ? item.image_paths : undefined,
    category_hint: item.category_hint,
    lat: item.lat,
    lng: item.lng,
    accuracy_m: item.accuracy_m,
    location_source: item.location_source,
    address_text: item.address_text,
  }
}

let flushing: Promise<number> | null = null

/**
 * Send every waiting report (oldest first). Removed on success or on a permanent 4xx (except 401); kept on
 * network errors / 5xx. Resolves with the number still waiting. Safe to call any time: concurrent calls share one run,
 * and other tabs are kept out with a Web Lock where supported.
 */
export function flushQueue(): Promise<number> {
  if (flushing) return flushing
  flushing = runFlush().finally(() => { flushing = null })
  return flushing
}

async function runFlush(): Promise<number> {
  if (!isOnline()) { await refresh(); return snap.count }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks?.request) {
    try {
      return await locks.request('awaaz-queue-flush', { ifAvailable: true }, async (lock) => {
        if (!lock) { await refresh(); return snap.count } // another tab is sending them
        return flushLocked()
      })
    } catch {
      return flushLocked()
    }
  }
  return flushLocked()
}

async function flushLocked(): Promise<number> {
  const all = await refresh()
  if (!all.length) return 0
  const uid = await currentUid()
  if (!uid) return all.length // signed out: uploads need the session (flushed again after sign-in)
  const mine = all.filter((i) => !i.uid || i.uid === uid)
  if (!mine.length) return all.length

  patch({ flushing: true, error: null })
  const placed: ProcessReportResponse[] = []
  const rejected: ProcessReportResponse[] = []
  let dropped = 0
  let stopped: QueueSnapshot['error'] = null
  let transientLeft = false
  const outcomes: Record<string, ItemOutcome> = {}

  for (const item of mine) {
    if (!isOnline()) { stopped = 'network'; break }
    patch({ current: item.client_id })
    try {
      const req = await prepare(item)
      const res = await api.processReport(req)
      await del(item.client_id, db())
      if (res.rejected) { rejected.push(res); outcomes[item.client_id] = { kind: 'rejected', res } }
      else { placed.push(res); outcomes[item.client_id] = { kind: 'placed', res } }
    } catch (e) {
      const verdict = classify(e)
      const message = e instanceof Error ? e.message : String(e)
      const uploadRefused = e instanceof MediaUploadError && e.code === 'upload'
      if (verdict === 'permanent' || (uploadRefused && item.attempts + 1 >= MAX_UPLOAD_FAILURES)) {
        await del(item.client_id, db()).catch(() => undefined)
        dropped++
        outcomes[item.client_id] = { kind: 'dropped', error: message }
      } else {
        item.attempts += 1
        item.last_error = message.slice(0, 300)
        item.last_try_at = new Date().toISOString()
        await put(item).catch(() => undefined)
        if (verdict === 'network') { stopped = 'network'; break }
        if (verdict === 'auth') { stopped = 'auth'; break }
        transientLeft = true
        stopped = 'server'
      }
    }
  }

  const left = await refresh()
  patch({
    flushing: false,
    current: null,
    error: stopped,
    outcomes: trimOutcomes({ ...snap.outcomes, ...outcomes }),
    ...(placed.length || rejected.length || dropped ? { last: { placed: placed.length + rejected.length, dropped, at: Date.now() } } : {}),
  })
  announce(placed, rejected, dropped, outcomes)

  if (placed.length || rejected.length || dropped) backoff = 0
  // a 5xx (AI / server down) or lie-fi ("online" but nothing gets through): try again later with backoff
  if (left.length && stopped !== 'auth' && isOnline() && (transientLeft || stopped === 'network')) scheduleRetry()
  return left.length
}

function trimOutcomes(o: Record<string, ItemOutcome>): Record<string, ItemOutcome> {
  const keys = Object.keys(o)
  if (keys.length <= 12) return o
  const out: Record<string, ItemOutcome> = {}
  for (const k of keys.slice(-12)) out[k] = o[k]
  return out
}

function uiLang(): Lang {
  return typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'ur'
}

/** Toasts for what the flush did (skipping reports a screen is already showing). */
function announce(placed: ProcessReportResponse[], rejected: ProcessReportResponse[], dropped: number, outcomes: Record<string, ItemOutcome>) {
  const lang = uiLang()
  const t = (k: string, vars?: Record<string, string | number>) => translate(lang, `alerts.${k}`, vars)
  const unseen = (r: ProcessReportResponse) => !Object.entries(outcomes).some(([id, o]) => 'res' in o && o.res === r && watched.has(id))
  const shown = placed.filter(unseen)
  if (shown.length === 1) {
    const r = shown[0]
    toast({
      title: t('offline_placedTitle'),
      body: (lang === 'ur' ? r.title_ur || r.title_en : r.title_en || r.title_ur) || undefined,
      url: r.cluster_id ? `/pin/${r.cluster_id}` : null,
      tone: 'success',
      icon: CloudCheck,
      color: STATUS_META.verified.color,
      durationMs: 9000,
    })
  } else if (shown.length > 1) {
    toast({
      title: t('offline_placedMany', { n: shown.length }),
      url: '/map',
      tone: 'success',
      icon: CloudCheck,
      color: STATUS_META.verified.color,
      durationMs: 9000,
    })
  }
  for (const r of rejected.filter(unseen)) {
    toast({
      title: t('offline_rejectedTitle'),
      body: (lang === 'ur' ? r.rejected?.message_ur || r.rejected?.message_en : r.rejected?.message_en || r.rejected?.message_ur) || undefined,
      tone: 'warning',
      icon: ShieldAlert,
      durationMs: 10_000,
    })
  }
  const droppedUnseen = Object.entries(outcomes).filter(([id, o]) => o.kind === 'dropped' && !watched.has(id)).length
  if (dropped && droppedUnseen) {
    toast({ title: t('offline_droppedTitle'), body: t('offline_droppedBody'), tone: 'error', icon: CloudOff, durationMs: 10_000 })
  }
  try { if (shown.length) navigator.vibrate?.([60, 60, 120]) } catch { /* unsupported */ }
}

// ---------------------------------------------------------------- retries, triggers, Background Sync

const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000]
let backoff = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRetry(ms?: number) {
  if (retryTimer) clearTimeout(retryTimer)
  const wait = ms ?? BACKOFF_MS[Math.min(backoff++, BACKOFF_MS.length - 1)]
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (isOnline()) void flushQueue()
  }, wait)
}

/** Ask the service worker to wake us when connectivity returns (Chrome/Android; no-op elsewhere). */
export async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    const sync = (reg as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined)?.sync
    await sync?.register(SYNC_TAG)
  } catch { /* unsupported or permission denied: the 'online' listener still flushes */ }
}

let started = false

/** Install the auto-flush triggers once (called by <OfflineBanner/>, which is mounted app-wide). */
export function initOfflineQueue(): void {
  if (started || typeof window === 'undefined') return
  started = true
  void refresh()
  window.addEventListener('online', () => {
    backoff = 0
    setTimeout(() => { if (isOnline()) void flushQueue() }, 1500) // let the connection settle
  })
  window.addEventListener('offline', () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isOnline() && snap.count > 0 && !snap.flushing) void flushQueue()
  })
  // Background Sync: the SW posts {type:'awaaz-sync'} with a reply port; answer with how many are still waiting
  navigator.serviceWorker?.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as { type?: string } | null
    if (data?.type !== SYNC_MESSAGE) return
    const port = ev.ports?.[0]
    void flushQueue().catch(() => snap.count).then((left) => { try { port?.postMessage({ remaining: left }) } catch { /* closed */ } })
  })
}
