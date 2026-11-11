// Small building blocks shared by the auth/account pages. Big tap targets, icon-first, RTL-safe (logical props only).
import clsx from 'clsx'
import { Check, CircleAlert, CircleCheck, Info, Loader2, X, type LucideIcon } from 'lucide-react'
import { useEffect, useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'
import type { Role } from '../../lib/types'
import { friendlyError } from './errors'
import { ROLE_META } from './meta'

/** Friendly, bilingual error box. Pass any thrown value; null renders nothing. */
export function ErrorBanner({ error, onDismiss, className }: { error: unknown; onDismiss?: () => void; className?: string }) {
  const { t } = useI18n()
  if (error === null || error === undefined || error === '') return null
  // plain i18n keys can be passed directly (validation messages)
  const isKey = typeof error === 'string' && error.startsWith('auth.')
  const fe = isKey ? { key: error, detail: '' } : friendlyError(error)
  const text = t(fe.key)
  const showDetail = fe.detail && fe.key === 'auth.err_generic'
  return (
    <div role="alert" className={clsx('flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-red-800', className)}>
      <CircleAlert className="mt-0.5 size-6 shrink-0 text-red-600" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{text}</div>
        {showDetail && <div dir="ltr" className="font-latin mt-1 break-words text-start text-xs text-red-700/80">{fe.detail}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label={t('auth.dismiss')}
          className="-m-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-red-100">
          <X className="size-5" />
        </button>
      )}
    </div>
  )
}

/** Success / info notice. */
export function Notice({ tone = 'info', icon, children, className }: {
  tone?: 'info' | 'success' | 'warn'; icon?: LucideIcon; children: ReactNode; className?: string
}) {
  const Icon = icon ?? (tone === 'success' ? CircleCheck : Info)
  return (
    <div className={clsx(
      'flex items-start gap-3 rounded-2xl border p-3',
      tone === 'success' && 'border-green-200 bg-green-50 text-green-900',
      tone === 'info' && 'border-sky-200 bg-sky-50 text-sky-900',
      tone === 'warn' && 'border-amber-200 bg-amber-50 text-amber-900',
      className,
    )}>
      <Icon className="mt-0.5 size-6 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Big tappable role card (icon + colour first, text second). */
export function RoleCard({ role, selected, current, loading, disabled, onClick, compact }: {
  role: Role; selected?: boolean; current?: boolean; loading?: boolean; disabled?: boolean; onClick: () => void; compact?: boolean
}) {
  const { t } = useI18n()
  const m = ROLE_META[role]
  const Icon = m.icon
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-pressed={selected}
      className={clsx(
        'relative flex w-full items-center gap-3 rounded-3xl border-2 bg-white text-start shadow-sm transition active:scale-[0.98] disabled:opacity-60',
        compact ? 'min-h-20 p-3' : 'min-h-24 p-4',
        selected ? 'shadow-md' : 'border-slate-200 hover:border-slate-300',
      )}
      style={selected ? { borderColor: m.color, background: m.soft } : undefined}
    >
      <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-2xl text-white', compact ? 'size-14' : 'size-16')}
        style={{ background: m.color }}>
        {loading ? <Loader2 className="size-8 animate-spin" /> : <Icon className="size-8" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-bold leading-tight">{t(`auth.role_${role}`)}</span>
        <span className="mt-0.5 block text-sm text-slate-600">{t(`auth.roleDesc_${role}`)}</span>
      </span>
      {current && (
        <span className="absolute -top-2 end-3 rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-white">{t('auth.current')}</span>
      )}
      {selected && (
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white" style={{ background: m.color }}>
          <Check className="size-5" />
        </span>
      )}
    </button>
  )
}

/** Labelled input with a leading icon. `ltr` forces left-to-right text (emails, passwords, numbers). */
export function TextField({ icon: Icon, label, hint, trailing, ltr, className, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & {
  icon: LucideIcon; label: string; hint?: string; trailing?: ReactNode; ltr?: boolean
}) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <label htmlFor={inputId} className={clsx('block', className)}>
      <span className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
        <Icon className="size-4 text-slate-500" /> {label}
      </span>
      <span className="relative block">
        <input
          id={inputId}
          dir={ltr ? 'ltr' : undefined}
          className={clsx(
            'min-h-14 w-full rounded-2xl border border-slate-300 bg-white px-4 text-base outline-none transition',
            'focus:border-brand-600 focus:ring-4 focus:ring-brand-100',
            ltr && 'font-latin text-start',
            trailing ? 'pe-14' : undefined,
          )}
          {...rest}
        />
        {trailing && <span className="absolute inset-y-0 end-1 flex items-center">{trailing}</span>}
      </span>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

/** Short-lived toast at the bottom of the screen. */
export function Toast({ message, onDone, tone = 'success' }: { message: string | null; onDone: () => void; tone?: 'success' | 'error' }) {
  useEffect(() => {
    if (!message) return
    const id = setTimeout(onDone, 3200)
    return () => clearTimeout(id)
  }, [message, onDone])
  if (!message) return null
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className={clsx(
        'pointer-events-auto flex max-w-md items-center gap-2 rounded-2xl px-4 py-3 font-semibold text-white shadow-xl',
        tone === 'success' ? 'bg-green-700' : 'bg-red-700',
      )}>
        {tone === 'success' ? <CircleCheck className="size-5" /> : <CircleAlert className="size-5" />}
        {message}
      </div>
    </div>
  )
}

/** Section heading with an icon. */
export function SectionTitle({ icon: Icon, children, right }: { icon: LucideIcon; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon className="size-5 text-brand-700" />
      <h2 className="flex-1 text-lg font-bold">{children}</h2>
      {right}
    </div>
  )
}
