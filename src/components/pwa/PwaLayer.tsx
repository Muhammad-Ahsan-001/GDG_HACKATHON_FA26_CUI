import { lazy, Suspense } from 'react'
import { SosTriggers } from '../sos/SosTriggers'
import { InstallPrompt } from './InstallPrompt'
import { OfflineBanner } from './OfflineBanner'
import { PushSync } from './PushSync'
import { Toaster } from './Toaster'
import { UpdatePrompt } from './UpdatePrompt'

// nearby danger / food rescue alerts (Realtime notifications) — own chunk, loaded after the first screen
const NearbyAlert = lazy(() => import('./NearbyAlert'))

/**
 * All global PWA UI in one top stack so the pieces never overlap each other:
 * offline pill → update card → install card → toasts. Mount once inside I18nProvider/AuthProvider/BrowserRouter.
 */
export function PwaLayer() {
  return (
    <>
      <PushSync />
      {/* SOS (women's safety): volume-key ×3 and opt-in shake triggers → /sos */}
      <SosTriggers />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <OfflineBanner />
        {/* hides itself on /sos (silent) and /onboarding */}
        <Suspense fallback={null}><NearbyAlert /></Suspense>
        <UpdatePrompt />
        <InstallPrompt />
        <Toaster />
      </div>
    </>
  )
}

export { InstallPrompt, OfflineBanner, PushSync, Toaster, UpdatePrompt }
