import clsx from 'clsx'
import { BellRing, CircleCheck, TriangleAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import type { Category } from '../../lib/types'

export type ToastItem =
  | { id: string; kind: 'new'; assignmentId: string; category: Category; title_en: string | null; title_ur: string | null; more: number }
  | { id: string; kind: 'ok' | 'error'; message: string }

const LIFETIME: Record<ToastItem['kind'], number> = { new: 9000, ok: 3500, error: 6000 }

/** In-page toast stack under the header ("New alert: …", action results). */
export function AlertToasts({ toasts, onOpen, onDismiss }: {
  toasts: ToastItem[]
  onOpen: (assignmentId: string) => void
  onDismiss: (id: string) => void
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-3" aria-live="assertive">
      {toasts.slice(-3).map((toast) => (
        <Toast key={toast.id} toast={toast} onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Toast({ toast, onOpen, onDismiss }: { toast: ToastItem; onOpen: (id: string) => void; onDismiss: (id: string) => void }) {
  const { t, pick, lang } = useI18n()
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), LIFETIME[toast.kind])
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.kind, onDismiss])

  const close = (
    <button
      type="button"
      aria-label={t('common.close')}
      onClick={(e) => { e.stopPropagation(); onDismiss(toast.id) }}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-black/10"
    >
      <X className="size-5" />
    </button>
  )

  if (toast.kind === 'new') {
    const cat = CATEGORY_META[toast.category] ?? CATEGORY_META.other
    const CatIcon = cat.icon
    const title = pick(toast.title_en, toast.title_ur) || (lang === 'ur' ? cat.ur : cat.en)
    return (
      <div role="alert" className="awaaz-dash-toast pointer-events-auto flex w-full max-w-lg items-center gap-2 rounded-2xl bg-red-600 p-2 text-white shadow-xl">
        <button
          type="button"
          onClick={() => { onOpen(toast.assignmentId); onDismiss(toast.id) }}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-start"
        >
          <span className="relative inline-flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-white" style={{ background: cat.color }}>
            <CatIcon className="size-6" />
            <BellRing className="absolute -top-1 -end-1 size-5 rounded-full bg-white p-0.5 text-red-600" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-extrabold">{t('dashboard.newAlert', { title })}</span>
            <span className="block text-sm opacity-90">
              {toast.more > 0 ? t('dashboard.moreNew', { n: toast.more }) : t('dashboard.tapToOpen')}
            </span>
          </span>
        </button>
        {close}
      </div>
    )
  }

  const ok = toast.kind === 'ok'
  const Icon = ok ? CircleCheck : TriangleAlert
  return (
    <div
      role={ok ? 'status' : 'alert'}
      className={clsx(
        'awaaz-dash-toast pointer-events-auto flex w-full max-w-lg items-center gap-2 rounded-2xl p-2 ps-3 shadow-xl',
        ok ? 'bg-green-700 text-white' : 'bg-ink text-white',
      )}
    >
      <Icon className={clsx('size-6 shrink-0', !ok && 'text-amber-300')} />
      <span className="min-w-0 flex-1 font-semibold">{toast.message}</span>
      {close}
    </div>
  )
}
