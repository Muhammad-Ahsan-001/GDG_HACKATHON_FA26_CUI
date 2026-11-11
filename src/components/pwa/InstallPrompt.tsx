import { CircleCheck, Download, Share, SquarePlus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import { onAppInstalled, promptInstall, useInstallState } from './install'
import { toast } from './toast'

const DISMISS_KEY = 'awaaz.installDismissedAt'
const DISMISS_FOR_MS = 3 * 24 * 3600 * 1000
const SHOW_DELAY_MS = 2500
const AUTO_HIDE_MS = 25_000
/** Only where the user is browsing — never over the report flow, a pin sheet or login. */
const ROUTES = new Set(['/', '/map', '/me', '/dashboard'])

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0)
    return Date.now() - at < DISMISS_FOR_MS
  } catch {
    return false
  }
}

/** Small "Install app" card (Android/desktop Chrome) or "Share → Add to Home Screen" hint (iOS Safari). */
export function InstallPrompt() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const { canInstall, iosHint } = useInstallState()
  const [hidden, setHidden] = useState(dismissedRecently)
  const [ready, setReady] = useState(false)
  const available = (canInstall || iosHint) && !hidden

  // appear a moment after the app settles, then get out of the way if ignored
  useEffect(() => {
    if (!available) return
    const show = setTimeout(() => setReady(true), SHOW_DELAY_MS)
    const hide = setTimeout(() => setHidden(true), SHOW_DELAY_MS + AUTO_HIDE_MS)
    return () => { clearTimeout(show); clearTimeout(hide) }
  }, [available])

  useEffect(() => onAppInstalled(() => {
    toast({ title: t('pwa.installed'), tone: 'success', color: STATUS_META.verified.color, durationMs: 4000 })
  }), [t])

  if (!available || !ready || !ROUTES.has(pathname)) return null

  const dismiss = () => {
    setHidden(true)
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* storage unavailable */ }
  }

  const closeButton = (
    <button
      type="button"
      onClick={dismiss}
      aria-label={t('pwa.notNow')}
      title={t('pwa.notNow')}
      className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
    >
      <X className="size-5" />
    </button>
  )

  if (canInstall) {
    return (
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-2xl bg-white p-1.5 shadow-xl ring-1 ring-black/5 transition-[opacity,translate] duration-200 starting:-translate-y-3 starting:opacity-0 motion-reduce:transition-none">
        <button
          type="button"
          onClick={() => {
            void promptInstall().then((outcome) => { if (outcome !== 'accepted') dismiss() })
          }}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 py-1 text-start active:bg-slate-50"
        >
          <img src="/icons/icon-192.png" alt="" width={44} height={44} className="size-11 shrink-0 rounded-xl" />
          <span className="min-w-0 flex-1">
            <span className="block font-bold leading-snug text-ink">{t('pwa.installTitle')}</span>
            <span className="line-clamp-2 block text-sm leading-snug text-slate-600">{t('pwa.installBody')}</span>
          </span>
          <span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-brand-700 px-3.5 text-sm font-bold text-white">
            <Download className="size-4" aria-hidden />
            {t('pwa.install')}
          </span>
        </button>
        {closeButton}
      </div>
    )
  }

  // iOS: there is no install API — show the three steps with big icons
  const steps = [
    { icon: Share, label: t('pwa.iosStep1') },
    { icon: SquarePlus, label: t('pwa.iosStep2') },
    { icon: CircleCheck, label: t('pwa.iosStep3') },
  ]
  return (
    <div className="pointer-events-auto w-full max-w-md rounded-2xl bg-white p-2 shadow-xl ring-1 ring-black/5">
      <div className="flex items-center gap-2 ps-1.5">
        <img src="/icons/icon-192.png" alt="" width={36} height={36} className="size-9 shrink-0 rounded-lg" />
        <span className="flex-1 font-bold text-ink">{t('pwa.iosTitle')}</span>
        {closeButton}
      </div>
      <ol className="mt-1 grid grid-cols-3 gap-2">
        {steps.map(({ icon: Icon, label }, i) => (
          <li key={label} className="flex flex-col items-center gap-1 rounded-xl bg-brand-50 p-2 text-center">
            <span className="relative inline-flex size-11 items-center justify-center rounded-full bg-white text-brand-700 shadow-sm">
              <Icon className="size-6" aria-hidden />
              <span className="font-latin absolute -top-1 -end-1 inline-flex size-5 items-center justify-center rounded-full bg-brand-700 text-xs font-bold text-white">
                {i + 1}
              </span>
            </span>
            <span className="text-xs font-semibold leading-snug text-ink">{label}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
