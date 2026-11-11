import clsx from 'clsx'
import { Check, Ear, Hand, Info, Loader2, ShieldCheck, Siren, Smartphone, Vibrate, Volume2, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { CATEGORY_META, URGENCY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import type { AppNotification } from '../../lib/types'
import { SOS_RED } from './meta'
import { motionSupported, requestMotionPermission, setSosSetting, useSosSettings } from './settings'
import { SosButton } from './SosButton'
import { SosLog } from './SosLog'
import { vibrate } from './sosClient'

const STEPS: { icon: LucideIcon; color: string; key: string }[] = [
  { icon: Hand, color: SOS_RED, key: 'sos.how1' },
  { icon: Ear, color: CATEGORY_META.safety.color, key: 'sos.how2' },
  { icon: Siren, color: URGENCY_META.high.color, key: 'sos.how3' },
  { icon: ShieldCheck, color: STATUS_META.verified.color, key: 'sos.how4' },
]

function Toggle({ on, busy, disabled, onToggle, label }: {
  on: boolean; busy?: boolean; disabled?: boolean; onToggle: () => void; label: string
}) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle} disabled={busy || disabled}
      className={clsx(
        'inline-flex h-12 w-20 shrink-0 items-center rounded-full p-1 transition disabled:opacity-60',
        on ? 'justify-end bg-green-600' : 'justify-start bg-slate-300',
      )}
    >
      <span className="inline-flex size-10 items-center justify-center rounded-full bg-white shadow">
        {busy ? <Loader2 className="size-5 animate-spin text-slate-500" /> : on ? <Check className="size-5 text-green-600" /> : null}
      </span>
    </button>
  )
}

function Row({ icon: Icon, title, body, children }: { icon: LucideIcon; title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: CATEGORY_META.safety.color }}>
        <Icon className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold leading-tight">{title}</div>
        <div className="text-sm text-slate-600">{body}</div>
      </div>
      {children}
    </div>
  )
}

/**
 * MePage SOS section: big hold-to-start SOS button, "How SOS works", trigger settings (volume 3× / shake /
 * app-icon shortcut) with the honest limitation note, and "My SOS log".
 */
export function SosPanel({ uid, notifications }: { uid: string | undefined; notifications: AppNotification[] | null }) {
  const { t } = useI18n()
  const settings = useSosSettings()
  const [shakeBusy, setShakeBusy] = useState(false)
  const [shakeMsg, setShakeMsg] = useState<string | null>(null)
  const canShake = motionSupported()

  function toggleVolume() {
    setSosSetting('volume', !settings.volume)
    vibrate(30)
  }

  async function toggleShake() {
    setShakeMsg(null)
    if (settings.shake) { setSosSetting('shake', false); return }
    setShakeBusy(true)
    try {
      // must run inside the tap (iOS permission prompt)
      const p = await requestMotionPermission()
      if (p === 'granted') { setSosSetting('shake', true); vibrate([40, 40, 40]) }
      else setShakeMsg(p === 'denied' ? 'sos.shakeDenied' : 'sos.shakeUnsupported')
    } finally {
      setShakeBusy(false)
    }
  }

  return (
    <section aria-labelledby="sos-panel-title" className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center gap-4 p-4" style={{ background: CATEGORY_META.safety.soft }}>
        <SosButton size={84} />
        <div className="min-w-0 flex-1">
          <h2 id="sos-panel-title" className="text-lg font-black leading-tight" style={{ color: CATEGORY_META.safety.color }}>
            {t('sos.meTitle')}
          </h2>
          <p className="mt-1 text-sm text-slate-700">{t('sos.meIntro')}</p>
        </div>
      </div>

      {/* how it works: four icon steps */}
      <div className="px-4 pt-3">
        <h3 className="text-sm font-bold text-slate-500">{t('sos.howTitle')}</h3>
        <ol className="mt-2 grid grid-cols-4 gap-2">
          {STEPS.map(({ icon: Icon, color, key }, i) => (
            <li key={key} className="flex flex-col items-center gap-1.5 text-center">
              <span className="relative inline-flex size-12 items-center justify-center rounded-2xl text-white" style={{ background: color }}>
                <Icon className="size-6" />
                <span className="font-latin absolute -end-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-white text-[11px] font-black text-slate-700 ring-1 ring-slate-200">
                  {i + 1}
                </span>
              </span>
              <span className="text-xs leading-snug text-slate-700">{t(key)}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* other ways to start SOS */}
      <div className="px-4 pt-3">
        <h3 className="text-sm font-bold text-slate-500">{t('sos.waysTitle')}</h3>
        <Row icon={Volume2} title={t('sos.volTitle')} body={t('sos.volBody')}>
          <Toggle on={settings.volume} onToggle={toggleVolume} label={t('sos.volTitle')} />
        </Row>
        <div className="h-px bg-slate-100" />
        <Row
          icon={Vibrate} title={t('sos.shakeTitle')}
          body={shakeMsg ? <span className="font-semibold text-amber-700">{t(shakeMsg)}</span> : canShake ? t('sos.shakeBody') : t('sos.shakeUnsupported')}
        >
          <Toggle on={settings.shake && canShake} busy={shakeBusy} disabled={!canShake} onToggle={() => { void toggleShake() }} label={t('sos.shakeTitle')} />
        </Row>
        <div className="h-px bg-slate-100" />
        <Row icon={Smartphone} title={t('sos.shortcutTitle')} body={t('sos.shortcutBody')} />
        <p className="mb-3 mt-1 flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <Info className="mt-0.5 size-4 shrink-0" /> <span>{t('sos.limitNote')}</span>
        </p>
      </div>

      <SosLog uid={uid} notifications={notifications} />
    </section>
  )
}
