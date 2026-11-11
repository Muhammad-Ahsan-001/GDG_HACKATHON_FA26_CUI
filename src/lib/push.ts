// Web push via Firebase Cloud Messaging, delivered through the app's own service worker (src/sw.ts).
// Firebase is lazy-imported so it never weighs on first load; everything is a graceful no-op when
// Firebase is not configured (VITE_FIREBASE_* / VITE_FIREBASE_VAPID_KEY empty) or the browser lacks Push.
import type { MessagePayload, Messaging } from 'firebase/messaging'
import { config, firebaseEnabled } from '../config'
import { supabase } from './supabase'

export type PushResult = 'granted' | 'denied' | 'unsupported' | 'error'

/** Foreground message, flattened for the UI (the SW shows nothing while the app is visible). */
export interface ForegroundMessage {
  title: string
  body: string
  /** in-app path to open, e.g. /pin/<cluster_id> */
  url: string | null
  type: string | null
  clusterId: string | null
  raw: MessagePayload
}

const SW_READY_TIMEOUT_MS = 10_000
const TOKEN_KEY = 'awaaz.fcmToken'

/** Synchronous capability check: Notification + Service Worker + Push API + Firebase configured + secure context. */
export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && firebaseEnabled
}

let messagingPromise: Promise<Messaging | null> | null = null

/** Lazily initialise Firebase Messaging (null when unsupported). Cached; a failed init can be retried. */
function loadMessaging(): Promise<Messaging | null> {
  if (!pushSupported()) return Promise.resolve(null)
  messagingPromise ??= (async () => {
    const [{ getApps, initializeApp }, { getMessaging, isSupported }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ])
    if (!(await isSupported())) return null
    const app = getApps()[0] ?? initializeApp(config.firebase)
    return getMessaging(app)
  })().catch((err: unknown) => {
    console.warn('[push] Firebase Messaging unavailable:', err)
    messagingPromise = null
    return null
  })
  return messagingPromise
}

/** The vite-plugin-pwa registration (scope "/"); null if no SW becomes ready in time (e.g. SW blocked). */
async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS))
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

/** Store this device's token for the signed-in user. RPC re-assigns a token that moved between accounts. */
async function saveToken(token: string): Promise<boolean> {
  const { data } = await supabase.auth.getSession()
  const userId = data.session?.user.id
  if (!userId) return false
  const userAgent = navigator.userAgent.slice(0, 400)
  const rpc = await supabase.rpc('register_device_token', { p_token: token, p_user_agent: userAgent })
  if (!rpc.error) return true
  // RPC not deployed yet → direct upsert (RLS: own rows only)
  const { error } = await supabase.from('device_tokens').upsert(
    { user_id: userId, fcm_token: token, user_agent: userAgent, last_seen_at: new Date().toISOString() },
    { onConflict: 'fcm_token' },
  )
  if (error) {
    console.warn('[push] could not save device token:', rpc.error.message, '/', error.message)
    return false
  }
  return true
}

/** Get (or refresh) the FCM token on the app's SW registration and save it for the current user. */
async function registerToken(): Promise<PushResult> {
  const messaging = await loadMessaging()
  if (!messaging) return 'unsupported'
  const registration = await swRegistration()
  if (!registration) return 'error'
  const { getToken } = await import('firebase/messaging')
  const token = await getToken(messaging, { vapidKey: config.vapidKey, serviceWorkerRegistration: registration })
  if (!token) return 'error'
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* storage unavailable */ }
  return (await saveToken(token)) ? 'granted' : 'error'
}

/**
 * Ask for notification permission (call from a button tap — required on iOS) and register this device.
 * 'denied' = the user blocked notifications; 'error' = dismissed the prompt or registration failed.
 */
export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return 'unsupported'
  try {
    let permission = Notification.permission
    if (permission === 'default') permission = await Notification.requestPermission()
    if (permission === 'denied') return 'denied'
    if (permission !== 'granted') return 'error'
    return await registerToken()
  } catch (err) {
    console.warn('[push] enablePush failed:', err)
    return 'error'
  }
}

/**
 * After login / account switch: if permission was already granted on this device, make sure its token
 * belongs to the current user. Never prompts.
 */
export async function refreshPushTokenIfGranted(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return
  try {
    await registerToken()
  } catch (err) {
    console.warn('[push] token refresh failed:', err)
  }
}

/** Subscribe to messages that arrive while the app is open and visible. Returns an unsubscribe function. */
export function onForegroundMessage(cb: (msg: ForegroundMessage) => void): () => void {
  if (!pushSupported()) return () => {}
  let unsubscribe: (() => void) | null = null
  let cancelled = false
  void (async () => {
    const messaging = await loadMessaging()
    if (!messaging || cancelled) return
    const { onMessage } = await import('firebase/messaging')
    if (cancelled) return
    unsubscribe = onMessage(messaging, (payload) => cb(toForeground(payload)))
  })()
  return () => {
    cancelled = true
    unsubscribe?.()
  }
}

function toForeground(payload: MessagePayload): ForegroundMessage {
  const data = payload.data ?? {}
  return {
    title: payload.notification?.title || data.title || '',
    body: payload.notification?.body || data.body || '',
    url: inAppPath(data.url || payload.fcmOptions?.link),
    type: data.type ?? null,
    clusterId: data.cluster_id ?? null,
    raw: payload,
  }
}

/** Reduce an absolute or relative link to a same-app path ("/pin/123"), or null. */
export function inAppPath(link: string | null | undefined): string | null {
  if (!link) return null
  try {
    const u = new URL(link, window.location.origin)
    const path = `${u.pathname}${u.search}${u.hash}`
    return path.startsWith('/') && !path.startsWith('//') ? path : null
  } catch {
    return null
  }
}
