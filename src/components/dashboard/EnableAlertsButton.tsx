import clsx from 'clsx'
import { BellOff, BellRing, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { enablePush, pushSupported } from '../../lib/push'
import { useI18n } from '../../lib/i18n'

type PushState = 'idle' | 'busy' | 'granted' | 'denied' | 'unsupported' | 'error'

function initialState(): PushState {
  try {
    if (!pushSupported()) return 'unsupported'
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') return 'granted'
      if (Notification.permission === 'denied') return 'denied'
    }
  } catch {
    return 'unsupported'
  }
  return 'idle'
}

/** "Enable alerts on this device" — registers this device's FCM token for the signed-in responder. */
export function EnableAlertsButton({ className }: { className?: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<PushState>(initialState)
  const autoRef = useRef(false)

  const run = async () => {
    setState('busy')
    try {
      setState(await enablePush())
    } catch {
      setState('error')
    }
  }

  // Permission already granted: silently (re-)register the token for the current account — no prompt shown.
  useEffect(() => {
    if (autoRef.current || state !== 'granted') return
    autoRef.current = true
    void enablePush().then((r) => { if (r !== 'granted') setState(r) }).catch(() => { /* keep showing granted */ })
  }, [state])

  if (state === 'unsupported') return null

  const on = state === 'granted'
  const blocked = state === 'denied'
  const label =
    on ? t('dashboard.alertsOn')
      : blocked ? t('dashboard.alertsDenied')
        : state === 'error' ? t('dashboard.alertsError')
          : t('dashboard.enableAlerts')
  const Icon = blocked ? BellOff : BellRing

  return (
    <button
      type="button"
      onClick={() => { if (state !== 'busy') void run() }}
      disabled={state === 'busy'}
      title={label}
      aria-label={label}
      className={clsx(
        'inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-sm font-bold transition active:scale-[0.98] disabled:opacity-70',
        on && 'bg-green-100 text-green-800',
        blocked && 'bg-slate-100 text-slate-600',
        state === 'error' && 'bg-red-50 text-red-700',
        (state === 'idle' || state === 'busy') && 'bg-brand-700 text-white hover:bg-brand-900',
        className,
      )}
    >
      {state === 'busy' ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
      <span className="max-w-[14rem] truncate">{label}</span>
    </button>
  )
}
