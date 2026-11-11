// Building blocks of the admin console: cards, skeletons, error/empty states, animated numbers, chips, drawer.
import clsx from 'clsx'
import { CircleAlert, Inbox, Lock, RefreshCw, X, type LucideIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from 'react'
import { useI18n } from '../../lib/i18n'

export function Card({ title, icon: Icon, action, children, className, bodyClass, sub }: {
  title?: ReactNode; icon?: LucideIcon; action?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; sub?: ReactNode
}) {
  return (
    <section className={clsx('min-w-0 rounded-2xl bg-white shadow-[0_1px_2px_rgb(15_23_42/0.04),0_10px_28px_-18px_rgb(15_118_110/0.18)] ring-1 ring-slate-200/70', className)}>
      {(title || action) && (
        <header className="flex items-center gap-2 px-4 pb-1 pt-3.5">
          {Icon && <Icon className="size-4.5 shrink-0 text-brand-600" />}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-bold text-slate-800">{title}</h2>
            {sub && <div className="truncate text-xs text-slate-500">{sub}</div>}
          </div>
          {action}
        </header>
      )}
      <div className={clsx(bodyClass ?? 'p-4 pt-2')}>{children}</div>
    </section>
  )
}

export function PanelHeader({ title, sub, icon: Icon, actions }: { title: string; sub?: ReactNode; icon: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-white via-brand-50 to-brand-100 text-brand-700 shadow-[0_6px_16px_-10px_rgb(15_118_110/0.5)] ring-1 ring-brand-100 sm:inline-flex">
          <Icon className="size-5.5" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-black tracking-tight text-slate-800 sm:text-2xl">{title}</h1>
          {sub && <p className="text-sm text-slate-500">{sub}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('adm-skel rounded-xl', className)} />
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2', className)} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-2/5" /></div>
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}

function errMessage(e: unknown): string {
  if (!e) return ''
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  const m = (e as { message?: string }).message
  return m || JSON.stringify(e)
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const { t } = useI18n()
  const msg = errMessage(error)
  const forbidden = /forbidden|42501|permission/i.test(msg)
  const Icon = forbidden ? Lock : CircleAlert
  return (
    <div role="alert" className={clsx('flex flex-col items-center gap-2 text-center', compact ? 'p-4' : 'p-10')}>
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-600 ring-1 ring-red-100"><Icon className="size-6" /></span>
      <div className="font-bold text-slate-800">{forbidden ? t('admin.errorForbidden') : t('admin.errorTitle')}</div>
      {!forbidden && msg && <div dir="ltr" className="font-latin max-w-md break-words text-xs text-slate-500">{msg}</div>}
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="mt-1 inline-flex min-h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-brand-900">
          <RefreshCw className="size-4" /> {t('common.retry')}
        </button>
      )}
    </div>
  )
}

export function Empty({ icon: Icon = Inbox, title, hint, children }: { icon?: LucideIcon; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-slate-50 text-slate-400 ring-1 ring-slate-200"><Icon className="size-7" /></span>
      <div className="font-bold text-slate-800">{title}</div>
      {hint && <div className="max-w-sm text-sm text-slate-500">{hint}</div>}
      {children}
    </div>
  )
}

/** Counts up to `value` (eased); static when reduced motion is preferred. */
export function AnimatedNumber({ value, format, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const reduce = useReducedMotion()
  const [shown, setShown] = useState(reduce ? value : 0)
  const from = useRef(reduce ? value : 0)
  useEffect(() => {
    if (reduce) { setShown(value); from.current = value; return }
    const start = performance.now()
    const a = from.current
    const dur = 700
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      setShown(a + (value - a) * e)
      if (p < 1) raf = requestAnimationFrame(step)
      else from.current = value
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); from.current = value }
  }, [value, reduce])
  const n = Number.isInteger(value) ? Math.round(shown) : Math.round(shown * 10) / 10
  return <span className={clsx('font-latin tabular-nums', className)}>{format ? format(n) : n.toLocaleString('en-US')}</span>
}

export function Chip({ active, onClick, icon: Icon, color, count, children, className }: {
  active?: boolean; onClick?: () => void; icon?: LucideIcon; color?: string; count?: number; children: ReactNode; className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold ring-1 transition',
        active ? 'bg-brand-700 text-white ring-brand-700 shadow-[0_6px_14px_-8px_rgb(15_118_110/0.6)]' : 'bg-white text-slate-700 ring-slate-200 hover:bg-brand-50/60 hover:ring-brand-100',
        className,
      )}
    >
      {Icon && <Icon className="size-4" style={!active && color ? { color } : undefined} />}
      {children}
      {typeof count === 'number' && (
        <span className={clsx('font-latin rounded-full px-1.5 text-[11px] tabular-nums', active ? 'bg-white/20' : 'bg-slate-100 text-slate-600')}>{count}</span>
      )}
    </button>
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={clsx(
        'min-h-9 rounded-xl border-0 bg-white pe-8 ps-3 text-sm font-semibold text-slate-800 ring-1 ring-slate-200 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-50',
        className,
      )}
    >
      {children}
    </select>
  )
}

export function Switch({ checked, onChange, label, disabled, tone = 'brand' }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; tone?: 'brand' | 'red'
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50',
        checked ? (tone === 'red' ? 'bg-red-600' : 'bg-brand-600') : 'bg-slate-300',
      )}
    >
      <span className={clsx('absolute size-5 rounded-full bg-white shadow transition-all', checked ? 'start-[22px]' : 'start-0.5')} />
    </button>
  )
}

/** AI confidence: thin meter + percentage. */
export function Confidence({ value, className }: { value: number | null | undefined; className?: string }) {
  const v = Math.max(0, Math.min(1, value ?? 0))
  const pct = Math.round(v * 100)
  const color = v >= 0.75 ? '#15803D' : v >= 0.5 ? '#B45309' : '#B91C1C'
  return (
    <span className={clsx('inline-flex items-center gap-2', className)} title={`${pct}%`}>
      <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-slate-100">
        <span className="absolute inset-y-0 start-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="font-latin text-xs font-bold tabular-nums text-slate-700">{pct}%</span>
    </span>
  )
}

export function Avatar({ name, color = '#0F766E', soft = '#CCFBF1', icon: Icon, size = 36 }: {
  name: string | null | undefined; color?: string; soft?: string; icon?: LucideIcon; size?: number
}) {
  const initials = (name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  return (
    <span className="font-latin inline-flex shrink-0 items-center justify-center rounded-full text-xs font-black"
      style={{ width: size, height: size, background: soft, color }}>
      {initials || (Icon ? <Icon className="size-4" /> : '?')}
    </span>
  )
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (o: number) => void }) {
  const { t } = useI18n()
  if (total <= limit && offset === 0) return null
  const from = total ? offset + 1 : 0
  const to = Math.min(total, offset + limit)
  const btn = 'inline-flex min-h-9 items-center rounded-xl px-3 text-sm font-semibold ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40'
  return (
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
      <span className="font-latin text-sm text-slate-500 tabular-nums">{t('admin.range', { from, to, total })}</span>
      <div className="flex gap-2">
        <button type="button" className={btn} disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{t('admin.prev')}</button>
        <button type="button" className={btn} disabled={to >= total} onClick={() => onChange(offset + limit)}>{t('admin.next')}</button>
      </div>
    </div>
  )
}

/** Side drawer (desktop, from the inline-end edge) / bottom sheet (mobile). */
export function Drawer({ open, onClose, title, children, header }: {
  open: boolean; onClose: () => void; title?: ReactNode; header?: ReactNode; children: ReactNode
}) {
  const { t, dir } = useI18n()
  const reduce = useReducedMotion()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  const off = dir === 'rtl' ? '-100%' : '100%'
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <motion.button
            type="button"
            aria-label={t('common.close')}
            className="absolute inset-0 bg-slate-500/25 backdrop-blur-[3px]"
            onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
          />
          <motion.aside
            className="adm-scroll absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl md:inset-y-0 md:end-0 md:start-auto md:max-h-none md:w-[min(560px,100vw)] md:rounded-none md:rounded-s-3xl"
            initial={reduce ? { opacity: 0 } : { x: window.innerWidth >= 768 ? off : 0, y: window.innerWidth >= 768 ? 0 : '100%' }}
            animate={reduce ? { opacity: 1 } : { x: 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { x: window.innerWidth >= 768 ? off : 0, y: window.innerWidth >= 768 ? 0 : '100%' }}
            transition={{ type: 'tween', ease: [0.22, 1, 0.36, 1], duration: reduce ? 0 : 0.28 }}
          >
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 pb-3 pt-4">
              <div className="min-w-0 flex-1">{header ?? <div className="text-lg font-bold text-slate-800">{title}</div>}</div>
              <button type="button" aria-label={t('common.close')} onClick={onClose}
                className="-me-2 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100">
                <X className="size-5" />
              </button>
            </div>
            <div className="adm-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}

export function Block({ title, icon: Icon, children, right }: { title: string; icon?: LucideIcon; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        {Icon && <Icon className="size-4 text-slate-400" />}
        <h3 className="flex-1 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  )
}

export function Badge({ color, soft, icon: Icon, children, className }: { color: string; soft: string; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold', className)} style={{ background: soft, color }}>
      {Icon && <Icon className="size-3.5" />}
      {children}
    </span>
  )
}
