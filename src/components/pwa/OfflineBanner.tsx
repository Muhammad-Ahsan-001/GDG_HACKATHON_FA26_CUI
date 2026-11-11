import clsx from 'clsx'
import { CloudCheck, Inbox, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useI18n } from '../../lib/i18n'
import { flushQueue, initOfflineQueue, useOfflineQueue } from '../../lib/offlineQueue'
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

const FLASH_MS = 3200
const PILL = 'pointer-events-auto inline-flex min-h-12 max-w-md items-center gap-2 rounded-full px-4 py-1.5 text-start text-sm font-bold text-white shadow-lg transition active:scale-[0.98]'

/**
 * Connectivity + offline-queue pill (top of the screen, app-wide):
 * offline (+ "N reports waiting") · "Sending…" while the queue flushes · a short success flash when saved reports
 * reach the map · "N waiting — tap to send" when online with reports still queued (tap retries) · "Back online".
 * Also installs the queue's auto-flush triggers and flushes on app start once signed in.
 */
export function OfflineBanner() {
  const { t } = useI18n()
  const online = useOnline()
  const q = useOfflineQueue()
  const { session } = useAuth()
  const uid = session?.user.id
  const { pathname } = useLocation()
  const quiet = pathname.startsWith('/sos') // SOS is a silent, dark screen: only the essential offline pill there

  const wasOffline = useRef(false)
  const [showBack, setShowBack] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [flash, setFlash] = useState<number | null>(null)

  useEffect(() => { initOfflineQueue() }, [])

  // app start / sign-in: send whatever was saved while offline
  useEffect(() => {
    if (uid && navigator.onLine) void flushQueue()
  }, [uid])

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

  // saved reports reached the map: short green flash
  const lastAt = q.last?.at ?? 0
  const lastPlaced = q.last?.placed ?? 0
  useEffect(() => {
    if (!lastPlaced || Date.now() - lastAt > 5000) return
    setFlash(lastPlaced)
    const id = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(id)
  }, [lastAt, lastPlaced])

  const waiting = q.count
  const waitingText = waiting === 1 ? t('alerts.offline_waitingOne') : t('alerts.offline_waiting', { n: waiting })

  if (!online) {
    const label = expanded
      ? [t('pwa.offline'), waiting > 0 ? t('alerts.offline_willSend') : ''].filter(Boolean).join(' ')
      : t('pwa.offlineShort')
    return (
      <button
        type="button"
        aria-live="polite"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        title={t('pwa.offline')}
        aria-label={waiting > 0 ? `${t('pwa.offline')} ${waitingText}` : t('pwa.offline')}
        className={clsx(PILL, 'bg-slate-800', expanded && 'rounded-2xl')}
      >
        <WifiOff className="size-5 shrink-0" aria-hidden />
        <span className="min-w-0">{label}</span>
        {waiting > 0 && !expanded && (
          <span className="ms-1 inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 text-xs">
            <Inbox className="size-4" aria-hidden />
            <span className="font-latin tabular-nums">{waiting}</span>
          </span>
        )}
      </button>
    )
  }

  if (!quiet && q.flushing && waiting > 0) {
    return (
      <div role="status" aria-live="polite" className={clsx(PILL, 'bg-brand-700')}>
        <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />
        <span>{waiting === 1 ? t('alerts.offline_sendingOne') : t('alerts.offline_sendingN', { n: waiting })}</span>
      </div>
    )
  }

  if (!quiet && flash) {
    return (
      <div role="status" aria-live="polite" className={PILL} style={{ background: STATUS_META.verified.color }}>
        <CloudCheck className="size-5 shrink-0" aria-hidden />
        <span>{flash === 1 ? t('alerts.offline_sentFlash') : t('alerts.offline_sentFlashMany', { n: flash })}</span>
      </div>
    )
  }

  if (!quiet && waiting > 0) {
    return (
      <button
        type="button"
        onClick={() => { void flushQueue() }}
        aria-label={`${waitingText} — ${t('alerts.offline_tapToSend')}`}
        title={t('alerts.offline_tapToSend')}
        className={PILL}
        style={{ background: STATUS_META.unconfirmed.color }}
      >
        <Inbox className="size-5 shrink-0" aria-hidden />
        <span>{waitingText}</span>
        <span className="ms-1 inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full bg-white/20 px-2.5 text-xs">
          <RefreshCw className="size-4" aria-hidden />
          <span className="hidden min-[380px]:inline">{t('alerts.offline_tapToSend')}</span>
        </span>
      </button>
    )
  }

  if (showBack) {
    return (
      <div role="status" className={PILL} style={{ background: STATUS_META.verified.color }}>
        <Wifi className="size-5" aria-hidden />
        {t('pwa.backOnline')}
      </div>
    )
  }

  return null
}
