/// <reference lib="webworker" />
// Awaaz service worker (vite-plugin-pwa injectManifest; built to /sw.js, scope "/").
// One worker does both jobs: Workbox precache/runtime caching AND Firebase Cloud Messaging background push.
import { clientsClaim, type WorkboxPlugin } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { initializeApp } from 'firebase/app'
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw'

declare let self: ServiceWorkerGlobalScope

/** Message the page listens for (src/components/pwa/PushSync.tsx) to navigate inside the SPA without a reload. */
const NAVIGATE_MSG = 'AWAAZ_NAVIGATE'
const FALLBACK_URL = '/map'
const APP_TITLE = 'Awaaz — آواز'
const ICON = '/icons/icon-192.png'
const BADGE = '/icons/badge-72.png'

// ---------------------------------------------------------------- lifecycle
// registerType 'autoUpdate': a new worker activates straight away; the page shows UpdatePrompt (onNeedReload).
self.addEventListener('install', () => { void self.skipWaiting() })
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting()
})
clientsClaim()

// ---------------------------------------------------------------- precache + SPA navigation
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Offline-capable SPA shell. In dev only "/" is handled so Vite's own routes keep working.
const navigationAllowlist = import.meta.env.DEV ? [/^\/$/] : undefined
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
  allowlist: navigationAllowlist,
  denylist: [/^\/api\//, /^\/__/],
}))

// ---------------------------------------------------------------- runtime caching
/** Only store real 200 responses (never opaque, never errors). */
const okOnly: WorkboxPlugin = {
  cacheWillUpdate: async ({ response }) => (response.status === 200 && response.type !== 'opaque' ? response : null),
}
/** Allow opaque responses too (cross-origin stylesheet loaded without CORS). */
const okOrOpaque: WorkboxPlugin = {
  cacheWillUpdate: async ({ response }) => (response.status === 200 || response.status === 0 ? response : null),
}
/**
 * `<img>` tags (Leaflet tiles, report photos) request cross-origin images in no-cors mode, which gives opaque
 * responses that Chrome pads to ~7 MB each in the storage quota. Both OSM and Supabase Storage send
 * `Access-Control-Allow-Origin: *`, so fetch them in CORS mode instead (cheap to cache, status visible).
 * If the CORS fetch fails, fall back to the browser's original request without caching it.
 */
const corsUpgrade: WorkboxPlugin = {
  requestWillFetch: async ({ request }) => (request.mode === 'no-cors'
    ? new Request(request.url, {
      mode: 'cors', credentials: 'omit', referrer: request.referrer, referrerPolicy: request.referrerPolicy,
    })
    : request),
  handlerDidError: async ({ request }) => fetch(request).catch(() => undefined),
}

// Google Fonts: stylesheet SWR, font files cache-first for a year.
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({
    cacheName: 'google-fonts-stylesheets',
    plugins: [okOrOpaque, new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 365 * 24 * 3600 })],
  }),
)
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [okOrOpaque, new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 365 * 24 * 3600, purgeOnQuotaError: true })],
  }),
)

// Supabase Storage public images (report photos). Audio (TTS) is NOT cached here: media players use Range requests.
const supabaseOrigin = safeOrigin(import.meta.env.VITE_SUPABASE_URL as string | undefined)
registerRoute(
  ({ url, request }) => url.origin === supabaseOrigin && request.destination === 'image'
    && /^\/storage\/v1\/(object|render\/image)\/public\//.test(url.pathname),
  new CacheFirst({
    cacheName: 'supabase-public-images',
    plugins: [corsUpgrade, okOnly, new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600, purgeOnQuotaError: true })],
  }),
)

// OpenStreetMap tiles (or VITE_MAP_TILE_URL's host): cache what the user actually viewed, never bulk-prefetch.
// Google Maps tiles/APIs are never cached (ToS) — no route matches them.
const tileHost = tileHostPattern(import.meta.env.VITE_MAP_TILE_URL as string | undefined)
registerRoute(
  ({ url, request }) => request.destination === 'image' && tileHost.test(url.hostname),
  new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [corsUpgrade, okOnly, new ExpirationPlugin({ maxEntries: 600, maxAgeSeconds: 7 * 24 * 3600, purgeOnQuotaError: true })],
  }),
)

function safeOrigin(u: string | undefined): string {
  try { return u ? new URL(u).origin : '' } catch { return '' }
}

/** Hostname matcher for the tile server(s); `{s}`-style placeholders in the template host match any label. */
function tileHostPattern(template: string | undefined): RegExp {
  const hosts = ['tile.openstreetmap.org', '{s}.tile.openstreetmap.org']
  const configured = template?.match(/^https?:\/\/([^/]+)/i)?.[1]?.replace(/:\d+$/, '')
  if (configured) hosts.push(configured)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alternatives = hosts.map((h) => h.split(/\{[a-z0-9_-]+\}/i).map(escape).join('[a-z0-9-]+'))
  return new RegExp(`^(?:${alternatives.join('|')})$`, 'i')
}

// ---------------------------------------------------------------- notification clicks
// Registered BEFORE getMessaging(): it handles both our own notifications and the ones FCM auto-displays
// (those carry data.FCM_MSG). The SDK's own handler only focuses the window without navigating, so we stop it.
interface FcmInternalPayload {
  fcmOptions?: { link?: string }
  notification?: { click_action?: string }
  data?: Record<string, string>
}

function targetPath(data: unknown): string {
  const d = (data ?? {}) as { url?: unknown; FCM_MSG?: FcmInternalPayload }
  const candidates: unknown[] = [d.url, d.FCM_MSG?.fcmOptions?.link, d.FCM_MSG?.data?.url, d.FCM_MSG?.notification?.click_action]
  const raw = candidates.find((c): c is string => typeof c === 'string' && c.length > 0) ?? FALLBACK_URL
  try {
    // links may point at another deployment of the app (APP_URL); always open the path on THIS origin
    const u = new URL(raw, self.location.origin)
    return `${u.pathname}${u.search}${u.hash}` || FALLBACK_URL
  } catch {
    return FALLBACK_URL
  }
}

async function openOrFocus(path: string): Promise<void> {
  const href = new URL(path, self.location.origin).href
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const ours = windows.filter((c) => new URL(c.url).origin === self.location.origin)
  const client = ours.find((c) => c.focused) ?? ours.find((c) => c.visibilityState === 'visible') ?? ours[0]
  if (client) {
    const focused = await client.focus().catch(() => client)
    if (focused.url !== href) focused.postMessage({ type: NAVIGATE_MSG, url: path })
    return
  }
  await self.clients.openWindow(href)
}

self.addEventListener('notificationclick', (event) => {
  event.stopImmediatePropagation()
  event.notification.close()
  event.waitUntil(openOrFocus(targetPath(event.notification.data)))
})

// ---------------------------------------------------------------- Firebase Cloud Messaging (background)
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
}

type ShowOptions = NotificationOptions & { renotify?: boolean; vibrate?: number[]; timestamp?: number }
const URGENT_TYPES = new Set(['new_assignment', 'nearby_alert', 'food_alert'])

if (firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.messagingSenderId && firebaseConfig.appId) {
  try {
    // Must run synchronously during the worker's first evaluation: the SDK adds its push listeners here.
    const messaging = getMessaging(initializeApp(firebaseConfig))
    onBackgroundMessage(messaging, (payload) => {
      // A `notification` payload has already been displayed by the SDK — showing it again would duplicate it.
      if (payload.notification) return
      const data = payload.data ?? {}
      const tag = data.cluster_id || data.tag || undefined
      const options: ShowOptions = {
        body: data.body || '',
        icon: ICON,
        badge: BADGE,
        tag,
        renotify: Boolean(tag),
        lang: data.lang || undefined,
        dir: 'auto',
        timestamp: Date.now(),
        vibrate: URGENT_TYPES.has(data.type ?? '') ? [200, 100, 200] : [120],
        data: { url: data.url || payload.fcmOptions?.link || FALLBACK_URL, type: data.type, cluster_id: data.cluster_id },
      }
      return self.registration.showNotification(data.title || APP_TITLE, options)
    })
  } catch (err) {
    // Unsupported browser or bad config: caching still works, push simply stays off.
    console.warn('[sw] FCM disabled:', err)
  }
}
