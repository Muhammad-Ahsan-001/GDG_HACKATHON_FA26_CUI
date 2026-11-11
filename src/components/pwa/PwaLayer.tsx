import { InstallPrompt } from './InstallPrompt'
import { OfflineBanner } from './OfflineBanner'
import { PushSync } from './PushSync'
import { Toaster } from './Toaster'
import { UpdatePrompt } from './UpdatePrompt'

/**
 * All global PWA UI in one top stack so the pieces never overlap each other:
 * offline pill → update card → install card → toasts. Mount once inside I18nProvider/AuthProvider/BrowserRouter.
 */
export function PwaLayer() {
  return (
    <>
      <PushSync />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <OfflineBanner />
        <UpdatePrompt />
        <InstallPrompt />
        <Toaster />
      </div>
    </>
  )
}

export { InstallPrompt, OfflineBanner, PushSync, Toaster, UpdatePrompt }
