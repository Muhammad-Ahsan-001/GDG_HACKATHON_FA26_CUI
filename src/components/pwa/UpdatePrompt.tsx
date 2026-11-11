import { CloudDownload, RotateCw, X } from 'lucide-react'
import { useEffect } from 'react'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import { applyUpdate, clearOfflineReady, dismissUpdate, useSwState } from './swState'
import { toast } from './toast'

/** "New version available — Refresh" card, plus a one-time "works offline" toast after first install. */
export function UpdatePrompt() {
  const { t } = useI18n()
  const { updateReady, offlineReady } = useSwState()

  useEffect(() => {
    if (!offlineReady) return
    toast({ title: t('pwa.offlineReady'), tone: 'success', icon: CloudDownload, color: STATUS_META.verified.color, durationMs: 4000 })
    clearOfflineReady()
  }, [offlineReady, t])

  if (!updateReady) return null
  return (
    <div className="pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-2xl bg-brand-900 p-1.5 text-white shadow-xl transition-[opacity,translate] duration-200 starting:-translate-y-3 starting:opacity-0 motion-reduce:transition-none">
      <button
        type="button"
        onClick={applyUpdate}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 py-1 text-start active:bg-white/10"
      >
        <span aria-hidden className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-white text-brand-700">
          <RotateCw className="size-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold leading-snug">{t('pwa.updateReady')}</span>
          <span className="block text-sm leading-snug text-white/80">{t('pwa.updateBody')}</span>
        </span>
        <span className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-white px-4 text-sm font-bold text-brand-900">
          {t('pwa.updateNow')}
        </span>
      </button>
      <button
        type="button"
        onClick={dismissUpdate}
        aria-label={t('pwa.dismiss')}
        title={t('pwa.dismiss')}
        className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/10"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}
