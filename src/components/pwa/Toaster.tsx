import clsx from 'clsx'
import {
  Bell, BellRing, ChevronLeft, ChevronRight, CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { onForegroundMessage } from '../../lib/push'
import { ASSIGNMENT_META, STATUS_META } from '../../lib/status'
import { dismissToast, holdToast, toast, useToasts, type Toast, type ToastTone } from './toast'

const BRAND = '#0f766e'

const TONE: Record<ToastTone, { color: string; icon: LucideIcon }> = {
  info: { color: BRAND, icon: Info },
  success: { color: STATUS_META.verified.color, icon: CircleCheck },
  warning: { color: STATUS_META.unconfirmed.color, icon: TriangleAlert },
  error: { color: '#dc2626', icon: CircleX },
  alert: { color: ASSIGNMENT_META.alerted.color, icon: BellRing },
}

/** Push `data.type` → icon, colour, fallback title key, urgency (vibration). */
function pushTypeMeta(type: string | null): { icon: LucideIcon; color: string; titleKey: string; urgent: boolean } {
  switch (type) {
    case 'new_assignment':
      return { icon: BellRing, color: ASSIGNMENT_META.alerted.color, titleKey: 'pwa.typeNewAssignment', urgent: true }
    case 'nearby_alert':
      return { icon: CATEGORY_META.hazard.icon, color: CATEGORY_META.hazard.color, titleKey: 'pwa.typeNearbyAlert', urgent: true }
    case 'food_alert':
      return { icon: CATEGORY_META.food.icon, color: CATEGORY_META.food.color, titleKey: 'pwa.typeFoodAlert', urgent: true }
    case 'verified':
      return { icon: STATUS_META.verified.icon, color: STATUS_META.verified.color, titleKey: 'pwa.typeVerified', urgent: false }
    case 'status_change':
      return { icon: STATUS_META.in_progress.icon, color: STATUS_META.in_progress.color, titleKey: 'pwa.typeStatusChange', urgent: false }
    default:
      return { icon: Bell, color: BRAND, titleKey: 'pwa.newAlert', urgent: false }
  }
}

function vibrate(pattern: number[]) {
  try { navigator.vibrate?.(pattern) } catch { /* not supported */ }
}

/**
 * Global toast list (rendered inside <PwaLayer/>'s top stack). Also turns foreground FCM messages into
 * tappable toasts. Needs the router (tap → navigate).
 */
export function Toaster() {
  const toasts = useToasts()
  const { t } = useI18n()
  // SOS is a silent, discreet screen: no toast may pop up or buzz there (an attacker could see / feel it)
  const quiet = useLocation().pathname.startsWith('/sos')
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])

  // While the app is visible the SW shows no system notification — surface the push here instead.
  useEffect(() => onForegroundMessage((m) => {
    if (window.location.pathname.startsWith('/sos')) return
    // the dashboard shows its own banner + beep for new cases (realtime); avoid a second toast there
    if (m.type === 'new_assignment' && window.location.pathname.startsWith('/dashboard')) return
    const meta = pushTypeMeta(m.type)
    toast({
      title: m.title || tRef.current(meta.titleKey),
      body: m.body || undefined,
      url: m.url ?? (m.clusterId ? `/pin/${m.clusterId}` : null),
      tone: 'alert',
      icon: meta.icon,
      color: meta.color,
      durationMs: 10_000,
    })
    vibrate(meta.urgent ? [200, 100, 200] : [80])
  }), [])

  if (quiet) return null
  return (
    <div className="flex w-full flex-col items-center gap-2 empty:hidden" role="status" aria-live="polite">
      {toasts.map((item) => <ToastCard key={item.id} item={item} />)}
    </div>
  )
}

function ToastCard({ item }: { item: Toast }) {
  const { t, dir } = useI18n()
  const nav = useNavigate()
  const tone = TONE[item.tone ?? 'info']
  const Icon = item.icon ?? tone.icon
  const color = item.color ?? tone.color
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight

  const open = () => {
    dismissToast(item.id)
    if (item.url) nav(item.url)
  }

  return (
    <div
      className={clsx(
        'pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-2xl bg-white p-1.5 shadow-xl ring-1 ring-black/5',
        'transition-[opacity,translate] duration-200 starting:-translate-y-3 starting:opacity-0 motion-reduce:transition-none',
      )}
      onPointerDown={() => holdToast(item.id)}
    >
      <button
        type="button"
        onClick={open}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 py-1 text-start active:bg-slate-50"
        aria-label={item.url ? `${item.title}. ${t('pwa.tapToOpen')}` : item.title}
      >
        <span
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white"
          style={{ background: color }}
          aria-hidden
        >
          <Icon className="size-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold leading-snug text-ink">{item.title}</span>
          {item.body && <span className="line-clamp-3 block text-sm leading-snug text-slate-600">{item.body}</span>}
        </span>
        {item.url && <Chevron className="size-5 shrink-0 text-slate-400" aria-hidden />}
      </button>
      <button
        type="button"
        onClick={() => dismissToast(item.id)}
        aria-label={t('pwa.dismiss')}
        title={t('pwa.dismiss')}
        className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}
