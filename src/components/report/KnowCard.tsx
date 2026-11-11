import clsx from 'clsx'
import { Check, ChevronDown, ClipboardList } from 'lucide-react'
import { memo, useState } from 'react'
import { USER_URGENCY_META, sortAttributes, type AttributeMap, type IntakeDraft, type UserUrgency } from '../../lib/attributes'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { AiLabel, CategoryIcon } from '../ui'
import { AttributeChips } from './AttributeChips'
import { asCategory } from './intake'

/** Live "what we know" card: AI draft title + attribute chips, refreshed after every turn. Tap to expand. */
export const KnowCard = memo(function KnowCard({ draft, attributes, version }: {
  draft: IntakeDraft | null
  attributes: AttributeMap
  /** bumps when the AI learnt something (drives a soft highlight) */
  version: number
}) {
  const { t, pick, lang } = useI18n()
  const [open, setOpen] = useState(false)
  const count = sortAttributes(attributes).length
  const category = asCategory(draft?.category)
  const title = draft ? pick(draft.title_en, draft.title_ur) : ''
  if (!title && count === 0) return null
  const meta = category ? CATEGORY_META[category] : null
  const collapsedMax = 3

  return (
    <section className="relative overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200" aria-live="polite">
      {version > 0 && <span key={version} aria-hidden className="awaaz-know-flash pointer-events-none absolute inset-0 bg-brand-100/70" />}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="relative flex w-full items-center gap-3 px-3 pb-2 pt-2.5 text-start"
      >
        {category ? <CategoryIcon category={category} size={40} /> : (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
            <ClipboardList className="size-5" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5 text-xs font-semibold text-slate-500">
            <span className="whitespace-nowrap">{t('report.whatWeKnow')}</span>
            {meta && <span className="whitespace-nowrap" style={{ color: meta.color }}>· {lang === 'ur' ? meta.ur : meta.en}</span>}
            {title && <AiLabel className="scale-90" />}
          </span>
          <span dir="auto" className={clsx('block font-bold leading-snug text-ink', !open && 'line-clamp-2')}>
            {title || t('report.listening')}
          </span>
        </span>
        <ChevronDown className={clsx('size-5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {count > 0 && (
        <div className="relative px-3 pb-3">
          <AttributeChips attributes={attributes} compact={!open} max={open ? undefined : collapsedMax}
            className={open ? undefined : 'max-h-7 overflow-hidden'} />
        </div>
      )}
    </section>
  )
})

/** Three big "how urgent" buttons (Emergency / Urgent / Can wait). */
export const UrgencyPicker = memo(function UrgencyPicker({ value, onPick, className }: {
  value: UserUrgency | null
  onPick: (u: UserUrgency) => void
  className?: string
}) {
  const { t, lang } = useI18n()
  const order: UserUrgency[] = ['emergency', 'urgent', 'can_wait']
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <span className="ps-11 text-sm font-semibold text-slate-600">{t('report.howUrgent')}</span>
      <div className="grid grid-cols-3 gap-2 ps-11" role="radiogroup" aria-label={t('report.howUrgent')}>
        {order.map((u) => {
          const m = USER_URGENCY_META[u]
          const Icon = m.icon
          const on = value === u
          return (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={lang === 'ur' ? m.ur : m.en}
              onClick={() => onPick(u)}
              className={clsx(
                'relative flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-2xl border-2 px-1 font-bold transition active:scale-95',
                value && !on && 'opacity-60',
              )}
              style={on
                ? { background: m.color, borderColor: m.color, color: '#fff' }
                : { background: m.soft, borderColor: 'transparent', color: m.color }}
            >
              <Icon className="size-7" />
              <span className="text-center text-sm leading-tight">{lang === 'ur' ? m.ur : m.en}</span>
              {on && (
                <span className="awaaz-pop-in absolute -top-1.5 -end-1.5 inline-flex size-6 items-center justify-center rounded-full bg-white shadow" style={{ color: m.color }}>
                  <Check className="size-4" strokeWidth={3} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
})
