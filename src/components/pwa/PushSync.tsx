import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { inAppPath, refreshPushTokenIfGranted } from '../../lib/push'

/** Message posted by src/sw.ts when a notification is tapped while the app is already open. */
const NAVIGATE_MSG = 'AWAAZ_NAVIGATE'

/**
 * Invisible glue:
 *  - after login / account switch, re-registers this device's FCM token for the new user (only if
 *    notification permission was already granted — never prompts);
 *  - turns notification taps into in-app navigation (no full reload).
 */
export function PushSync() {
  const { user } = useAuth()
  const nav = useNavigate()
  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) return
    // let the first screen render before touching Firebase
    const id = setTimeout(() => { void refreshPushTokenIfGranted() }, 1500)
    return () => clearTimeout(id)
  }, [userId])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null
      if (data?.type !== NAVIGATE_MSG || typeof data.url !== 'string') return
      const path = inAppPath(data.url)
      if (path) nav(path)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [nav])

  return null
}
