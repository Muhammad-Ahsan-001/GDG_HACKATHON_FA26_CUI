import clsx from 'clsx'
import { Wifi, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'

function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}
const getOnline = () => navigator.onLine
const getServerOnline = () => true

/** Reactive navigator.onLine. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getOnline, getServerOnline)
}

/** Compact pill while offline (tap to read the full message); a short "Back online" pill when it returns. */
export function OfflineBanner() {
  const { t } = useI18n()
  const online = useOnline()
  const wasOffline = useRef(false)
  const [showBack, setShowBack] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!online) {
      wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    setExpanded(false)
    setShowBack(true)
    const id = setTimeout(() => setShowBack(false), 2500)
    return () => clearTimeout(id)
  }, [online])

  if (online && !showBack) return null

  if (online) {
    return (
      <div
        role="status"
        className="pointer-events-auto inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-bold text-white shadow-lg"
        style={{ background: STATUS_META.verified.color }}
      >
        <Wifi className="size-5" aria-hidden />
        {t('pwa.backOnline')}
      </div>
    )
  }

  return (
    <button
      type="button"
      aria-live="polite"
      onClick={() => setExpanded((v) => !v)}
      title={t('pwa.offline')}
      aria-label={t('pwa.offline')}
      className={clsx(
        'pointer-events-auto inline-flex min-h-12 max-w-md items-center gap-2 rounded-full bg-slate-800 px-4 py-1.5 text-start text-sm font-bold text-white shadow-lg',
        expanded && 'rounded-2xl',
      )}
    >
      <WifiOff className="size-5 shrink-0" aria-hidden />
      <span>{expanded ? t('pwa.offline') : t('pwa.offlineShort')}</span>
    </button>
  )
}
