/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { markOfflineReady, markUpdateReady } from './components/pwa/swState'

// ---- Service worker (src/sw.ts: precache, runtime caches, FCM background push) ----
const UPDATE_CHECK_MS = 30 * 60 * 1000

const updateSW = registerSW({
  immediate: true,
  // registerType 'autoUpdate': the new worker already took control — offer a refresh instead of
  // reloading under the user's feet (they may be mid-recording).
  onNeedReload() { markUpdateReady(() => window.location.reload()) },
  // 'prompt' mode (if ever switched): activate the waiting worker; the plugin reloads once it controls the page
  onNeedRefresh() { markUpdateReady(() => { void updateSW(true) }) },
  onOfflineReady() { markOfflineReady() },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    let lastCheck = Date.now()
    const check = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return
      if (Date.now() - lastCheck < 60_000) return
      lastCheck = Date.now()
      void registration.update().catch(() => undefined)
    }
    setInterval(check, UPDATE_CHECK_MS)
    document.addEventListener('visibilitychange', check)
  },
  onRegisterError(error) { console.warn('[pwa] service worker registration failed:', error) },
})

// A lazy chunk from a previous deploy is gone (new SW + new build): reload once to pick up the new build.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'awaaz.chunkReloadAt'
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < 15_000) return // already tried — let the error surface instead of looping
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch { /* storage unavailable: still reload once */ }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
