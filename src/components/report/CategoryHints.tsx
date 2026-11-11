import clsx from 'clsx'
import { Check, Tags } from 'lucide-react'
import { memo } from 'react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { CATEGORIES, type Category } from '../../lib/types'
import { CategoryIcon } from '../ui'

/** Optional category hint: one tap on an icon; tap again to clear. The AI decides anyway.
 *  Memoised: the sheet re-renders ~12x/s while recording (level meter). */
export const CategoryHints = memo(function CategoryHints({ value, onChange }: {
  value: Category | null; onChange: (c: Category | null) => void
}) {
  const { t, lang } = useI18n()
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-600">
        <Tags className="size-4" /> {t('report.categoryHint')}
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 pt-1.5 [scrollbar-width:none]">
        {CATEGORIES.map((c) => {
          const m = CATEGORY_META[c]
          const on = value === c
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(on ? null : c)}
              aria-pressed={on}
              aria-label={lang === 'ur' ? m.ur : m.en}
              className={clsx(
                'relative flex min-h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border-2 transition active:scale-95',
                on ? 'bg-white' : 'border-transparent bg-slate-50',
                value && !on && 'opacity-50',
              )}
              style={on ? { borderColor: m.color, background: m.soft } : undefined}
            >
              <CategoryIcon category={c} size={36} />
              <span className="max-w-full truncate px-0.5 text-[11px] font-semibold leading-tight text-slate-700">{lang === 'ur' ? m.ur : m.en}</span>
              {on && (
                <span className="absolute -top-1 -end-1 inline-flex size-5 items-center justify-center rounded-full text-white" style={{ background: m.color }}>
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
})
