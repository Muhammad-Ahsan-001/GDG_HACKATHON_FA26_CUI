// Big phone-style numeric keypad (always left-to-right like every phone dialer, also in Urdu).
import { Delete } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useI18n } from '../../lib/i18n'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export function Keypad({ onDigit, onBackspace, onClear, disabled }: {
  onDigit: (d: string) => void
  onBackspace: () => void
  onClear: () => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // physical keyboards (desktop testing, Bluetooth keyboards)
  useEffect(() => {
    if (disabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); onDigit(e.key) }
      else if (e.key === 'Backspace') { e.preventDefault(); onBackspace() }
      else if (e.key === 'Escape') onClear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled, onDigit, onBackspace, onClear])

  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current) }, [])

  const tap = (fn: () => void) => () => {
    try { navigator.vibrate?.(12) } catch { /* unsupported */ }
    fn()
  }

  const keyCls = 'font-latin inline-flex h-16 items-center justify-center rounded-2xl bg-white text-3xl font-bold text-ink shadow-sm ring-1 ring-slate-200 transition active:scale-95 active:bg-brand-50 disabled:opacity-40'

  return (
    <div dir="ltr" className="grid grid-cols-3 gap-2.5" role="group">
      {KEYS.map((k) => (
        <button key={k} type="button" disabled={disabled} onClick={tap(() => onDigit(k))} className={keyCls} aria-label={k}>
          {k}
        </button>
      ))}
      <span aria-hidden />
      <button type="button" disabled={disabled} onClick={tap(() => onDigit('0'))} className={keyCls} aria-label="0">0</button>
      <button
        type="button"
        disabled={disabled}
        onClick={tap(onBackspace)}
        // long-press clears the whole number
        onPointerDown={() => { holdTimer.current = setTimeout(() => { holdTimer.current = null; onClear() }, 650) }}
        onPointerUp={() => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null } }}
        onPointerLeave={() => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null } }}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={t('onboarding.backspace')}
        title={t('onboarding.backspace')}
        className="inline-flex h-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-700 shadow-sm ring-1 ring-slate-200 transition active:scale-95 disabled:opacity-40"
      >
        <Delete className="size-8" />
      </button>
    </div>
  )
}
