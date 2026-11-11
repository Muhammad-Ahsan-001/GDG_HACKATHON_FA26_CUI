# Awaaz: frontend and push research (as of 2026-11-11)

Versions come from the npm registry (`registry.npmjs.org/<pkg>`, queried today). Everything else comes from official docs, package source on GitHub/unpkg, or is marked **UNVERIFIED**.

## 0. Version pins (npm `latest` today)

| Package | Latest | Published | Peer / engine notes |
|---|---|---|---|
| firebase | **13.2.0** | 2026-11-02 (release notes date it Oct 30) | 13.0.0 (Oct 7, 2026) was a major. Its breaking changes are all AI Logic; none touch Messaging. `@firebase/messaging` is 0.13.3 |
| vite-plugin-pwa | **2.0.0** | 2026-10-03 | peer `vite ^3.1…^8.0.0`, `workbox-build/window ^7.4.1`. **Node >=20.19.0** (README: "From v2.0.0 … requires Node 20.19.0 or above") |
| workbox-precaching / -routing / -core / -window | **7.4.1** | 2026-05-04 | |
| @vis.gl/react-google-maps | **1.10.2** | 2026-10-30 | peer react `>=16.8 \|\| ^19` |
| @googlemaps/markerclusterer | **2.6.2** | 2025-07-08 | |
| vite | **8.3.8** | 2026-11-11 | Node `^20.19.0 \|\| >=22.12.0`. Vite 8.0 shipped 2026-03-12 (Rolldown + Oxc) |
| @vitejs/plugin-react | **6.3.0** | 2026-11-09 | **peer `vite ^8.0.0`**. Uses Oxc and no longer depends on Babel. v5 still works with Vite 8 |
| react / react-dom | **19.3.1** | 2026-10-14 | |
| tailwindcss / @tailwindcss/vite | **4.3.5** | 2026-11-06 | peer `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8` |
| idb-keyval | **6.3.0** | 2026-07-08 | |
| idb | **8.0.4** | 2026-10-06 | |
| jose | **6.2.17** | 2026-11-09 | Also on JSR as `jsr:@panva/jose@6.2.17` |
| typescript | **7.0.2** | 2026-07-08 | The official create-vite `template-react-ts` now uses `typescript ~7.0.2`, `vite ^8.3.6`, `@vitejs/plugin-react ^6.2.1`, `react ^19.3.1` and oxlint |

Sources: https://www.npmjs.com (registry API), https://firebase.google.com/support/release-notes/js, https://raw.githubusercontent.com/vite-pwa/vite-plugin-pwa/main/README.md, https://vite.dev/blog/announcing-vite8, https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts

---

## 1. FCM web push with a custom SW that is also the vite-plugin-pwa SW

### BIG CHANGE: `getToken()` is deprecated in favour of Firebase Installation IDs (FIDs)
- In the current typings and docs, `getToken` and `deleteToken` are marked `@deprecated`. The doc text reads: "Use register() together with onRegistered() for Firebase Installation ID-based messaging." The client docs label the token APIs as ones that "will be removed in a future release". The new API was added in 12.14.0 (May 28, 2026): "Added new API for creating and deleting Cloud Messaging registration."
- New signatures, verified in the published `@firebase/messaging@0.13.3` `dist/index-public.d.ts`:
  - `register(messaging, options?: RegisterOptions): Promise<void>`
  - `unregister(messaging): Promise<void>`
  - `onRegistered(messaging, NextFn<string>|Observer<string>): Unsubscribe`
  - `onUnregistered(messaging, …): Unsubscribe`
  - `RegisterOptions { vapidKey?: string; serviceWorkerRegistration?: ServiceWorkerRegistration }` has the same shape as `GetTokenOptions`.
- Server side: in FCM v1, `Message.token` is "**deprecated**: Use `fid` instead. During the transition period, this field also accepts a Firebase Installation ID (FID)". The new target field is `"fid": string`. Per manage-tokens, "both patterns are fully co-supported" during the transition.
- Gotchas found in the SDK source (`packages/messaging/src/api/register.ts`):
  - `register()` throws `INVALID_ON_REGISTERED_HANDLER` unless `onRegistered` is attached **first**.
  - It calls `Notification.requestPermission()` itself when permission is `default`, and throws `PERMISSION_BLOCKED` if permission is not granted.
  - It re-syncs with the backend only on first run, when the FID changes, or after 7 days. `onRegistered` still fires on every call.
  - The docs say not to mix the FID APIs with the deprecated token APIs.
- Sources:
  - https://firebase.google.com/docs/cloud-messaging/js/client
  - https://firebase.google.com/docs/reference/js/messaging_
  - https://firebase.google.com/docs/reference/js/messaging_.registeroptions
  - https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
  - https://firebase.google.com/docs/cloud-messaging/manage-tokens
  - https://github.com/firebase/firebase-js-sdk/blob/main/packages/messaging/src/api/register.ts

### Default-SW and scope gotchas (from SDK source `packages/messaging/src/util/constants.ts` and `helpers/registerDefaultSw.ts`)
- If you do **not** pass `serviceWorkerRegistration`, the SDK calls `navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' })`. You then have a second SW alongside the PWA SW at `/`.
- **Always pass the same registration**, i.e. the vite-plugin-pwa one with scope `/`. The push subscription belongs to a registration, so switching registrations produces a new identity. The SDK throws `INVALID_SW_REGISTRATION` if the value is not a `ServiceWorkerRegistration`.
- GetTokenOptions doc: if no registration is provided, "your project needs a firebase-messaging-sw.js file at its root". The receive doc says you can hand an existing SW to the SDK instead.
- Sources: https://firebase.google.com/docs/reference/js/messaging_.gettokenoptions and https://firebase.google.com/docs/cloud-messaging/js/receive

### SW behaviour (from SDK source `listeners/sw-listeners.ts` and `helpers/register.ts`)
- The `push`, `pushsubscriptionchange` and `notificationclick` listeners are added when **`getMessaging(app)` runs in the SW**, not when the module is imported. Add your own `notificationclick` listener **before** calling `getMessaging()`. The docs say to handle notificationclick "before importing FCM libraries. Otherwise, FCM may overwrite it."
- Foreground: if any window client is `visibilityState === 'visible'`, the SW forwards the payload to the page's `onMessage` and **shows nothing**.
- Background with a `notification` payload: the SDK auto-calls `showNotification`, then also calls `onBackgroundMessage`. Do **not** call `showNotification` again in that case or the user gets duplicates.
- Background with a data-only payload: you must call `self.registration.showNotification` yourself. **UNVERIFIED:** Chrome may otherwise show a generic notification, because pushes require a user-visible notification.
- When the SDK handles a click on its own notification, it calls `stopImmediatePropagation()`. It then opens or focuses `webpush.fcm_options.link` (falling back to `notification.click_action`) **only if the link's host equals the SW origin's host**; otherwise the click does nothing.
- Data messages do not support `fcm_options.link`. Handle clicks yourself (receive doc).
- Sources: https://github.com/firebase/firebase-js-sdk/blob/main/packages/messaging/src/listeners/sw-listeners.ts and https://firebase.google.com/docs/cloud-messaging/js/receive

### `src/sw.ts` (injectManifest; bundled by vite-plugin-pwa, so npm imports work)
```ts
/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { initializeApp } from 'firebase/app'
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw'
declare let self: ServiceWorkerGlobalScope

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))
self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting() })

// Must come BEFORE getMessaging(). Handles our own data-only notifications; FCM's own ones carry data.FCM_MSG.
self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data as any)?.url as string | undefined
  if (!url) return
  event.notification.close()
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const hit = wins.find((c) => new URL(c.url).pathname === new URL(url, self.location.origin).pathname)
    return hit ? hit.focus() : self.clients.openWindow(url)
  })())
})

const app = initializeApp({
  apiKey: import.meta.env.VITE_FB_API_KEY, projectId: import.meta.env.VITE_FB_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FB_SENDER_ID, appId: import.meta.env.VITE_FB_APP_ID,
})
const messaging = getMessaging(app)
onBackgroundMessage(messaging, (p) => {
  if (p.notification) return            // SDK already displayed it
  const d = p.data ?? {}
  return self.registration.showNotification(d.title ?? 'Awaaz', {
    body: d.body, icon: '/pwa-192x192.png', tag: d.tag, data: { url: d.url ?? '/' },
  })
})
```
The modular SDK in a SW requires bundling (receive doc). vite-plugin-pwa builds the SW with Vite. For the `es` format it sets `inlineDynamicImports: true`, so the output is a single file (from `vite-plugin-pwa@2.0.0/dist/vite-build-*.js`). `import.meta.env` works in the SW build because the plugin has `envOptions` since 0.19.6.

### Page side (React)
```ts
import { initializeApp } from 'firebase/app'
import { getMessaging, isSupported, onMessage, onRegistered, onUnregistered, register } from 'firebase/messaging'
const app = initializeApp(firebaseConfig)

export async function enablePush(saveFid: (fid: string) => Promise<void>, dropFid: (fid: string) => Promise<void>) {
  if (!('serviceWorker' in navigator) || !(await isSupported())) return false
  const reg = await navigator.serviceWorker.ready   // the vite-plugin-pwa SW (scope '/'); hangs forever if no SW is registered, so add a timeout
  const messaging = getMessaging(app)
  onRegistered(messaging, (fid) => void saveFid(fid))     // upsert into Supabase with updated_at
  onUnregistered(messaging, (fid) => void dropFid(fid))
  onMessage(messaging, (p) => {/* in-app toast: the SW shows nothing while the app is visible */})
  await register(messaging, { vapidKey: import.meta.env.VITE_FCM_VAPID_KEY, serviceWorkerRegistration: reg })
  return true
}
// Deprecated fallback: const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: reg })
```
- Call `enablePush` from a **button tap**. On iOS the permission request must come from direct user interaction, and `register()` requests permission internally.
- Store a timestamp with each FID. FID clients need no refresh job. Legacy token clients should refresh about monthly, and treat registrations inactive for more than a month as stale (https://firebase.google.com/docs/cloud-messaging/manage-tokens).
- The SDK only works on HTTPS pages (client doc).
- iOS/iPadOS 16.4+ supports web push **only for Home Screen web apps**. That needs a manifest with `display: standalone` or `fullscreen` and a permission request from a user gesture (https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
- **UNVERIFIED / risky:** FCM on iOS Safari. Firebase does not explicitly confirm it, and there are open firebase-js-sdk issues, including a report of `getToken` failing on iOS 26.0.1 (https://github.com/firebase/firebase-js-sdk/issues/7734 and https://github.com/firebase/firebase-js-sdk/issues/7309). Treat Android Chrome as the supported path.

---

## 2. FCM HTTP v1 send from a Deno (Supabase) Edge Function

- **Send endpoint:** `POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`. The project number is also accepted. Body: `{ "message": Message, "validate_only"?: boolean }`. Accepted scopes are `https://www.googleapis.com/auth/firebase.messaging` or `https://www.googleapis.com/auth/cloud-platform` (https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send).
- **Message fields:** `data` (string→string map only), `notification {title, body, image}`, `webpush`, `android`/`android_v2`, `apns`, `fcm_options`. At most one target: `token` (deprecated), `fid`, `topic`, or `condition`.
  - `WebpushConfig { headers (e.g. "TTL":"15"), data, notification (Web Notification API props; its title/body override the top level), fcm_options { link (HTTPS required), analytics_label } }`.
  - Source: https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
- **OAuth token (service-account JWT bearer flow):**
  - Header `{alg:"RS256", typ:"JWT"[, kid]}`.
  - Claims: `iss` = client_email, `scope`, `aud` = `https://oauth2.googleapis.com/token`, `iat`, and `exp` (at most iat + 1h).
  - POST `https://oauth2.googleapis.com/token` with `Content-Type: application/x-www-form-urlencoded`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion=<jwt>`.
  - Response `{access_token, token_type:"Bearer", expires_in:3600, scope}`. Reuse the token until it expires.
  - Sources: https://developers.google.com/identity/protocols/oauth2/service-account and https://firebase.google.com/docs/cloud-messaging/auth-server (scope, Bearer header, "make sure the Firebase Cloud Messaging API is enabled").
- **jose API:**
  - `importPKCS8(pkcs8: string, alg: string, options?) → Promise<CryptoKey>`. RSA keys must use the rsaEncryption OID; Google service-account `private_key` is a PKCS#8 `BEGIN PRIVATE KEY` PEM.
  - `SignJWT(payload).setProtectedHeader().setIssuer().setAudience().setIssuedAt().setExpirationTime()`. A number argument means absolute epoch seconds; a string such as `'1h'` is relative.
  - Sources: https://github.com/panva/jose/blob/main/docs/key/import/functions/importPKCS8.md and https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md
- **Supabase imports:** `npm:` (recommended) or `jsr:`, ideally declared in a per-function `supabase/functions/<fn>/deno.json` `imports` map (https://supabase.com/docs/guides/functions/dependencies).

```ts
// supabase/functions/send-push/index.ts
import { importPKCS8, SignJWT } from 'npm:jose@6.2.17' // or 'jsr:@panva/jose@6.2.17'

type SA = { project_id: string; client_email: string; private_key: string; private_key_id?: string }
const sa: SA = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT')!)       // set with: supabase secrets set FCM_SERVICE_ACCOUNT="$(cat sa.json)"
const pem = sa.private_key.replace(/\\n/g, '\n')                     // no-op if JSON.parse already unescaped the newlines
let cached: { token: string; exp: number } | null = null              // may survive warm invocations (not guaranteed)

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.exp - 120 > now) return cached.token
  const key = await importPKCS8(pem, 'RS256')
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })
    .setIssuer(sa.client_email).setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key)
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!r.ok) throw new Error(`oauth ${r.status}: ${await r.text()}`)
  const j = await r.json() as { access_token: string; expires_in: number }
  cached = { token: j.access_token, exp: now + j.expires_in }
  return j.access_token
}

export async function sendWebPush(target: { fid?: string; token?: string },
  n: { title: string; body: string; link: string; data?: Record<string, string> }) {
  const message = {
    ...(target.fid ? { fid: target.fid } : { token: target.token }),
    notification: { title: n.title, body: n.body },
    data: n.data ?? {},                                   // values MUST be strings
    webpush: {
      headers: { TTL: '86400', Urgency: 'high' },
      notification: { icon: 'https://YOUR_APP/pwa-192x192.png', tag: n.data?.tag },
      fcm_options: { link: n.link },                       // absolute https URL on the SAME host as the SW
    },
  }
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (r.ok) return { ok: true as const, name: (await r.json()).name as string } // "projects/…/messages/…"
  const err = await r.json().catch(() => ({}))
  const code: string | undefined = err?.error?.details?.find(
    (d: any) => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode
  const dead = (r.status === 404 && code === 'UNREGISTERED') ||
               (r.status === 400 && code === 'INVALID_ARGUMENT') || // only if the payload is known-good
               (r.status === 403 && code === 'SENDER_ID_MISMATCH')
  return { ok: false as const, status: r.status, code, dead, retryAfter: r.headers.get('retry-after') }
}

Deno.serve(async (req) => { const { fid, title, body, link } = await req.json(); return Response.json(await sendWebPush({ fid }, { title, body, link })) })
```

- **Error shape:** `{"error":{"code","message","status","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"…"}]}}`. Bad field values use a `google.rpc.BadRequest` detail with `fieldViolations` instead (https://firebase.google.com/docs/cloud-messaging/error-codes.md.txt).
- **Codes** (https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode):
  - `UNREGISTERED` 404: delete the token/FID.
  - `INVALID_ARGUMENT` 400.
  - `SENDER_ID_MISMATCH` 403.
  - `QUOTA_EXCEEDED` 429: back off, at least 1 minute for the message-rate quota.
  - `UNAVAILABLE` 503: honour `Retry-After`, exponential backoff.
  - `INTERNAL` 500: retry with backoff.
  - `THIRD_PARTY_AUTH_ERROR` 401.
- Manage-tokens says to treat 404 UNREGISTERED and 400 INVALID_ARGUMENT as invalid registrations **only when the payload is valid**, then delete them, because "it will never again be valid".
- **UNVERIFIED:**
  - Self-signed JWT without the token exchange (`aud: https://fcm.googleapis.com/`). Google's addendum allows this pattern for googleapis-defined APIs, but FCM acceptance was not confirmed. Use the OAuth exchange above.
  - The FCM webpush payload size limit was not verified.

---

## 3. vite-plugin-pwa 2.0.0 (injectManifest, Vite 8)

- **2.0.0 release notes** list no functional breaking changes beyond **Node >=20.19**, plus allowing `@vite-pwa/assets-generator ^2.0.0` (the generator is now 2.0.0). 1.3.0 added the Vite 8 peer and an `onNeedReload` client callback (https://github.com/vite-pwa/vite-plugin-pwa/releases). **UNVERIFIED:** the full 1.3→2.0 diff was not read.
- **Config rules** (https://vite-pwa-org.netlify.app/guide/inject-manifest):
  - `srcDir` is relative to the project root; `filename` (with extension) is relative to `srcDir`. `sw.ts` is emitted as `sw.js`.
  - Recommended SW code: call `cleanupOutdatedCaches()`.
  - For `registerType: 'autoUpdate'`, use `self.skipWaiting()` plus `clientsClaim()` from `workbox-core`. For the prompt flow, handle the `SKIP_WAITING` message.
  - Add `"WebWorker"` to tsconfig `lib`. The official React example instead puts `/// <reference lib="webworker" />` in `vite-env.d.ts` alongside `vite-plugin-pwa/react` and `vite-plugin-pwa/info` (https://github.com/vite-pwa/vite-plugin-pwa/tree/main/examples/react-router).
- **Type facts** (`vite-plugin-pwa@2.0.0/dist/index.d.ts`):
  - `injectManifest.rollupFormat` defaults to `'es'`.
  - Also available: `buildPlugins {rollup, vite}`, `rollupOptions`, `target`, `minify`, `sourcemap`, `enableWorkboxModulesLogs`.
  - `injectRegister: 'inline'|'script'|'script-defer'|'auto'|null|false`.
  - `registerType: 'prompt'|'autoUpdate'`.
  - The build throws if `maximumFileSizeToCacheInBytes` (Workbox default 2 MiB) is exceeded, unless `showMaximumFileSizeToCacheInBytesWarning: true`.
  - `devOptions {enabled, type: 'classic'|'module', navigateFallback (injectManifest only, default 'index.html')}`.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
  plugins: [
    react(), tailwindcss(),
    VitePWA({
      strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts',
      registerType: 'prompt',           // or 'autoUpdate' (then skipWaiting + clientsClaim in the SW)
      injectRegister: 'auto',           // default; does nothing when you import virtual:pwa-register/*
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'] },
      manifest: {
        name: 'Awaaz', short_name: 'Awaaz', description: '…', lang: 'ur', dir: 'auto',
        start_url: '/', scope: '/', display: 'standalone', theme_color: '#0f766e', background_color: '#ffffff',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
    }),
  ],
})
```

- **Installability:**
  - vite-pwa minimum (https://vite-pwa-org.netlify.app/guide/pwa-minimal-requirements): name, short_name, description, theme_color (must match `<meta name="theme-color">`), 192 and 512 PNG icons, a maskable 512, `apple-touch-icon` 180x180, HTTPS, manifest served as `application/manifest+json`.
  - Chrome criteria (https://web.dev/articles/install-criteria): `short_name` or `name`, 192px and 512px icons, `start_url`, `display` in {fullscreen, standalone, minimal-ui, window-controls-overlay}, `prefer_related_applications` absent or false, HTTPS, and an engagement heuristic (one click plus 30s).
  - Chrome dropped the fetch-handler requirement for menu install in Chrome 108 mobile / 112 desktop (https://developer.chrome.com/blog/update-install-criteria). Precaching adds a fetch handler anyway.
  - iOS needs `display: standalone` for push (see §1).
- **Dev mode:** module SWs work "only on latest versions of Chromium based browsers" in dev, and the dev SW URL is `/dev-sw.js?dev-sw`. The production SW is always registered as `type: 'classic'` (https://vite-pwa-org.netlify.app/guide/development).
- **React hook** (`virtual:pwa-register/react`, typings checked in the 2.0.0 package):
  - `useRegisterSW(options?: RegisterSWOptions) → { needRefresh: [bool, set], offlineReady: [bool, set], updateServiceWorker(reloadPage?) }`.
  - Options: `immediate`, `onNeedReload`, `onNeedRefresh`, `onOfflineReady`, `onRegisteredSW(swUrl, registration)` (`onRegistered` is deprecated and ignored if `onRegisteredSW` is present), `onRegisterError`.
  - Add `"types": ["vite-plugin-pwa/react"]` or `/// <reference types="vite-plugin-pwa/react" />`.
  - Sources: https://vite-pwa-org.netlify.app/frameworks/react and https://vite-pwa-org.netlify.app/guide/periodic-sw-updates
  ```tsx
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(url, r) { r && setInterval(() => r.update(), 60 * 60 * 1000) },
  })
  ```
- **UNVERIFIED:**
  - injectManifest dev mode under Vite 8 / Rolldown: no specific bug found.
  - Vercel: keep `/sw.js` and `/manifest.webmanifest` out of the SPA rewrite, serve `/sw.js` with `Cache-Control: no-cache`, and check that Vercel's MIME type for `.webmanifest` is correct.

---

## 4. Google Maps JS in React (@vis.gl/react-google-maps 1.10.2)

- **APIProvider props:** `apiKey` (required), `version` (default `weekly`), `libraries`, `region`, `language`, `authReferrerPolicy`, `channel`, `solutionChannel` (default `GMP_VISGL_react`), `disableUsageAttribution`, `fetchAppCheckToken`, `onLoad`, `onError`. Hooks: `useApiIsLoaded()`, `useApiLoadingStatus()` (https://visgl.github.io/react-google-maps/docs/api-reference/components/api-provider).
- **Map:**
  - Needs center and zoom (controlled), or `defaultCenter`/`defaultZoom`, or `defaultBounds`.
  - Default props apply only at init. Controlled mode requires writing `onCameraChanged` events back into state.
  - Changing `mapId`, `colorScheme` or `renderingType` **recreates** the map.
  - `reuseMaps` (experimental) caches instances. Pricing is per map load, so this saves money on remounts.
  - `renderingType` is `'RASTER'|'VECTOR'`; vector "may be unavailable on some devices" and falls back to raster.
  - Source: https://visgl.github.io/react-google-maps/docs/api-reference/components/map
- **AdvancedMarker** needs a map with `mapId` (cloud styling). Google: "Advanced markers requires a map ID. If the map ID is missing, advanced markers cannot load."
  - **`mapId: 'DEMO_MAP_ID'` is officially allowed for testing**; replace it for production (https://developers.google.com/maps/documentation/javascript/advanced-markers/start).
  - Props: `position`, `zIndex`, `clickable` (auto-on when onClick is set), `collisionBehavior`, `title`, `draggable`. `anchorPoint` is deprecated since 1.6 in favour of `anchorLeft`/`anchorTop`. Also available: `<Pin background borderColor glyphColor/>` and `useAdvancedMarkerRef()` for `InfoWindow anchor`.
  - Sources: https://visgl.github.io/react-google-maps/docs/api-reference/components/advanced-marker and https://visgl.github.io/react-google-maps/docs/whats-new
- **Legacy `google.maps.Marker`** has been deprecated since Feb 2024 (v3.56), with no shutdown date yet.
- **Heatmap Layer** (`visualization`) is **decommissioned as of May 2026**, along with the Drawing library. For heatmaps use deck.gl `HeatmapLayer` + `GoogleMapsOverlay`, which needs a vector map (https://developers.google.com/maps/deprecations and https://developers.google.com/maps/documentation/javascript/examples/deckgl-heatmap).
- **Client-side geocoding:**
  - Hook: `useMapsLibrary(name)` returns the `importLibrary` result (https://visgl.github.io/react-google-maps/docs/api-reference/hooks/use-maps-library).
  - The JS Geocoder **requires the Geocoding API to be enabled** in the same project.
  - Request: exactly one of `address`/`location`/`placeId`, plus optional `bounds`, `componentRestrictions`, `region`, `fulfillOnZeroResults`. There is no per-request `language`; language is set at API load.
  - Statuses: OK, ZERO_RESULTS, OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST, UNKNOWN_ERROR, ERROR (https://developers.google.com/maps/documentation/javascript/geocoding).
  ```tsx
  const geocodingLib = useMapsLibrary('geocoding')
  const geocoder = useMemo(() => geocodingLib && new geocodingLib.Geocoder(), [geocodingLib])
  // reverse geocode:
  const { results } = await geocoder!.geocode({ location: { lat, lng } })
  const addr = results[0]?.formatted_address // display only; do not parse it
  ```
- **Clustering** (official vis.gl example `examples/marker-clustering`, which pins `@googlemaps/markerclusterer ^2.6.2`, react 19, vite 8):
  - Create `new MarkerClusterer({ map })` in `useMemo` from `useMap()`.
  - Collect `AdvancedMarkerElement` refs through a stable `useCallback` ref setter keyed by id.
  - In an effect, call `clusterer.clearMarkers(); clusterer.addMarkers(Object.values(markers))`.
  - The default algorithm is supercluster (k-d tree). The default renderer uses `AdvancedMarkerElement` when `map.getMapCapabilities().isAdvancedMarkersAvailable`.
  - Sources: https://github.com/visgl/react-google-maps/tree/main/examples/marker-clustering and https://github.com/googlemaps/js-markerclusterer (README and `src/renderer.ts`)
  - `npm i @googlemaps/markerclusterer@2.6.2`
- **Tips for cheap Android phones.** These are derived from the docs above; the ones marked "heuristic" are UNVERIFIED.
  1. Keep the camera uncontrolled (`defaultCenter`/`defaultZoom`); controlled mode re-renders React on every camera change.
  2. Use `reuseMaps` and keep `mapId`/`colorScheme`/`renderingType` constant.
  3. Cluster, and fetch only in-viewport points on `onIdle` (debounced; PostGIS bbox query).
  4. Keep marker children tiny (a `Pin` or small span), with memoized components and stable callbacks as in the example.
  5. Use `gestureHandling="greedy"` and `disableDefaultUI` for full-screen mobile maps.
  6. Lazy-load the map route with `React.lazy` and mount `APIProvider` only there.
  7. Heuristic: consider `renderingType="RASTER"` on low-end GPUs.
- **Geocoding REST with an HTTP-referrer-restricted browser key, called from a server: NO.**
  - Google's security guide lists the Geocoding API (web service) under **IP-address** restrictions and the JS Geocoding *Service* under **Websites**: "Server-side applications relying on API keys are best secured through IP address restrictions"; one key per app/platform (https://developers.google.com/maps/api-security-best-practices).
  - The widely reported error is `REQUEST_DENIED: "API keys with referer restrictions cannot be used with this API."` This is community-sourced, e.g. https://forum.bubble.io/t/google-geocode-api-api-keys-with-referer-restrictions-cannot-be-used-with-this-api/217055.
  - Supabase Edge Functions **have no static egress IP**, so IP restriction is impractical (https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0).
  - Option for a server key: no application restriction, API-restricted to the Geocoding API only, stored as a secret. Alternatively, geocode on the client.
- **Maps Demo Key:** a key that needs no credit card, with a daily per-API cap and service pausing when the cap is hit. It lists Dynamic Maps and Geocoding (JS and API) among the supported products (https://mapsplatform.google.com/maps-demo-key/). Advanced Markers and referrer behaviour under the demo key are **UNVERIFIED**.

---

## 5. Tailwind v4 + RTL, Vite 8 + React 19, IndexedDB

- **Install:** `npm install tailwindcss @tailwindcss/vite`, then `plugins: [tailwindcss()]`, then put `@import "tailwindcss";` in your CSS. No config file is required (https://tailwindcss.com/docs/installation/using-vite).
- **Browser baseline:** Chrome 111, Safari 16.4, Firefox 128 (https://tailwindcss.com/docs/compatibility). **Very old Android WebViews / Chrome < 111 will render broken styles.**
- **RTL:**
  - Set `<html dir="rtl" lang="ur">`, e.g. `document.documentElement.dir = isRtl ? 'rtl' : 'ltr'`.
  - The `rtl:`/`ltr:` variants compile to `&:where(:dir(rtl), [dir="rtl"], [dir="rtl"] *)` (https://tailwindcss.com/docs/hover-focus-and-other-states).
  - Prefer logical utilities: `ms-*`/`me-*` (margin-inline-start/end), `ps-*`/`pe-*`, `mbs-*`/`mbe-*`, `pbs-*`/`pbe-*`, `border-bs`/`border-be-*`, and `inline-*`/`block-*` sizing (v4.2+).
  - Use `inset-s-*`/`inset-e-*`/`inset-bs-*`/`inset-be-*` for positioning. **`start-*`/`end-*` still work but are deprecated in favour of `inset-s-*`/`inset-e-*`** (v4.3 post).
  - Use `rtl:` only for things logical properties can't express, such as flipping a directional icon (`rtl:-scale-x-100`).
  - Sources: https://tailwindcss.com/docs/margin, https://tailwindcss.com/docs/top-right-bottom-left, https://tailwindcss.com/blog/tailwindcss-v4-3
- **Vite 8 (current major, 8.3.8):**
  - Rolldown is the single bundler and Oxc the compiler. A compatibility layer auto-converts `esbuild`/`rollupOptions` config.
  - Requires Node 20.19+ or 22.12+. The install is about 15 MB larger than Vite 7.
  - `@vitejs/plugin-react` v6 needs Vite 8; it uses Oxc for React Refresh and has no Babel. React Compiler is an opt-in through `reactCompilerPreset` with `@rolldown/plugin-babel`.
  - React 19.3.1 is fine: the create-vite template ships it.
  - Every key plugin declares Vite 8 in its peers: vite-plugin-pwa 2.0, @tailwindcss/vite 4.3.5, plugin-react 6.
  - Source: https://vite.dev/blog/announcing-vite8
  - **UNVERIFIED:** whether all tooling works under TypeScript 7.0 (create-vite now defaults to it). If anything breaks, pin `typescript@~6.0.3`.
- **IndexedDB helper:**
  - **idb-keyval 6.3.0** is "295 bytes (brotli'd)" for get/set and 573 bytes with all methods. It supports `createStore(db, store)` for a custom store and suits an offline draft/outbox queue (also usable in the SW).
  - Use **idb 8.0.4** (~1.19 kB brotli) only if you need indexes, cursors or transactions.
  - Sources: https://github.com/jakearchibald/idb-keyval and https://github.com/jakearchibald/idb

---

## 6. MediaRecorder audio formats

- **Safari (macOS/iOS):** the MediaRecorder API was enabled by default in iOS 14.3 and Safari TP 105. Initially MP4 only, with **AAC** audio (https://webkit.org/blog/11353/mediarecorder-api/).
- **Safari 18.4** (March 2025): "MediaRecorder … now supports creating WebM files using the Opus audio codec". It can also create fragmented MP4 and lossless ALAC/PCM tracks (https://webkit.org/blog/16574/webkit-features-in-safari-18-4/). Safari 26.0 added ALAC/PCM recording, and 26.2 has stop/track-change fixes (https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).
- **Chrome (desktop and Android):** WebM/Opus is the long-standing default. **MP4 container (H.264/AAC) shipped in Chrome 126, desktop and Android** (chromestatus feature 5163469011943424, https://chromestatus.com/feature/5163469011943424).
- **API:** `MediaRecorder.isTypeSupported(mimeType) → boolean`. `false` means the browser cannot record that format; `true` can still fail for lack of resources (https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).

```ts
const CANDIDATES = [
  'audio/webm;codecs=opus',       // Chrome/Android, Firefox, Safari 18.4+
  'audio/mp4;codecs=mp4a.40.2',   // Safari 14.1+/iOS 14.3+ (AAC), Chrome 126+
  'audio/mp4',
  'audio/ogg;codecs=opus',        // Firefox
  'audio/webm',
]
export const pickAudioMime = () =>
  typeof MediaRecorder === 'undefined' ? undefined : CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))

const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
const mime = pickAudioMime()
const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined)
const chunks: Blob[] = []
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
rec.onstop = () => {
  const type = rec.mimeType || mime || 'audio/webm'           // use what the browser actually produced
  const blob = new Blob(chunks, { type })
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
  stream.getTracks().forEach((t) => t.stop())                // release the mic indicator
  // upload as `voice.${ext}` with contentType = type.split(';')[0]
}
rec.start(1000)
```

- **Gotchas:**
  - Start recording from a user gesture, over HTTPS.
  - Build the Blob in `onstop`. A Safari TP 256 fix concerned final data loss when stopping during a pending timeslice (https://webkit.org/blog/18602/release-notes-for-safari-technology-preview-256/).
  - **UNVERIFIED:** Chrome WebM blobs lack duration metadata, which affects `<audio>` seek bars, not transcription.

---

## Could not verify / flagged
1. Full vite-plugin-pwa 1.3.0→2.0.0 changelog: only the Node 20.19 requirement and the assets-generator peer are confirmed.
2. Firebase 13.x minimum browser / TypeScript / ES target: no changes were listed in the release notes.
3. Official Firebase statement on FCM support in iOS Safari Home Screen apps: only GitHub issues exist, some reporting failures on iOS 26.
4. Whether FCM v1 accepts a self-signed JWT without the OAuth exchange.
5. The FCM web push payload size limit.
6. Vercel default caching and MIME type for `sw.js` / `.webmanifest`.
7. Maps Demo Key support for Advanced Markers / mapId.
8. Concrete Maps performance numbers (e.g. a marker-count threshold); the tips above are derived.
9. Chrome WebM missing-duration behaviour.
10. TypeScript 7 tooling compatibility.
