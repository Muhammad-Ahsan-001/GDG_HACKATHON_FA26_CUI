// Shared UI primitives. Large tap targets (>= 48px), icon-first. Import from '../components/ui'.
import clsx from 'clsx'
import { Loader2, Sparkles, X, type LucideIcon } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { CATEGORY_META, URGENCY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import type { Category, ReportStatus, Urgency } from '../../lib/types'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-600 active:scale-[0.98]',
  secondary: 'bg-white text-ink border border-slate-200 hover:bg-slate-50',
  ghost: 'bg-transparent text-ink hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  success: 'bg-green-600 text-white hover:bg-green-700',
}

export function Button({
  variant = 'primary', size = 'md', icon: Icon, loading, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: LucideIcon; loading?: boolean
}) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' && 'min-h-10 px-3 text-sm',
        size === 'md' && 'min-h-12 px-4 text-base',
        size === 'lg' && 'min-h-14 px-6 text-lg',
        VARIANTS[variant], className,
      )}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <Loader2 className="size-5 animate-spin" /> : Icon ? <Icon className="size-5" /> : null}
      {children}
    </button>
  )
}

export function IconButton({
  icon: Icon, label, size = 56, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: number }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx('inline-flex items-center justify-center rounded-full shadow-md transition active:scale-95 disabled:opacity-50', className)}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon style={{ width: size * 0.45, height: size * 0.45 }} />
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin', className ?? 'size-6')} />
}

/** Mandatory label on every AI output. */
export function AiLabel({ className }: { className?: string }) {
  const { t } = useI18n()
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700', className)}>
      <Sparkles className="size-3" /> {t('common.aiAssessed')}
    </span>
  )
}

export function CategoryIcon({ category, size = 40, className }: { category: Category; size?: number; className?: string }) {
  const m = CATEGORY_META[category] ?? CATEGORY_META.other
  const Icon = m.icon
  return (
    <span
      className={clsx('inline-flex shrink-0 items-center justify-center rounded-full text-white', className)}
      style={{ width: size, height: size, background: m.color }}
    >
      <Icon style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  )
}

export function StatusBadge({ status, count, className }: { status: ReportStatus; count?: number; className?: string }) {
  const { lang } = useI18n()
  const m = STATUS_META[status] ?? STATUS_META.unconfirmed
  const Icon = m.icon
  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold', className)}
      style={{ background: m.soft, color: m.color }}
    >
      <Icon className="size-4" />
      {lang === 'ur' ? m.ur : m.en}
      {typeof count === 'number' && <span className="font-latin rounded-full bg-white/70 px-1.5 text-xs">{count}</span>}
    </span>
  )
}

export function UrgencyBadge({ urgency, className }: { urgency: Urgency; className?: string }) {
  const { lang } = useI18n()
  const m = URGENCY_META[urgency] ?? URGENCY_META.medium
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold text-white', className)} style={{ background: m.color }}>
      {lang === 'ur' ? m.ur : m.en}
    </span>
  )
}

/** Bottom sheet (mobile) / side panel (desktop >= md). */
export function Sheet({
  open, onClose, children, title, className,
}: { open: boolean; onClose: () => void; children: ReactNode; title?: ReactNode; className?: string }) {
  const { t } = useI18n()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:items-stretch md:justify-end" role="dialog" aria-modal="true">
      <button aria-label={t('common.close')} className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={clsx(
        'relative z-10 max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl',
        'md:max-h-none md:w-[440px] md:rounded-none md:rounded-s-3xl',
        className,
      )}>
        <div className="mb-2 flex items-center gap-2">
          <div className="flex-1 text-lg font-bold">{title}</div>
          <button aria-label={t('common.close')} onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-full hover:bg-slate-100">
            <X className="size-6" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center text-slate-500">
      <Icon className="size-12 text-slate-300" />
      <div className="font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  )
}

/** "5 min ago" in the current language. */
export function useTimeAgo() {
  const { t } = useI18n()
  return (iso: string | null | undefined) => {
    if (!iso) return ''
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
    if (mins < 1) return t('common.justNow')
    if (mins < 60) return t('common.minutesAgo', { n: mins })
    const h = Math.round(mins / 60)
    if (h < 48) return t('common.hoursAgo', { n: h })
    return t('common.daysAgo', { n: Math.round(h / 24) })
  }
}
