import clsx from 'clsx'
import { LayoutGrid } from 'lucide-react'
import { memo } from 'react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { CATEGORIES, type Category } from '../../lib/types'

export interface CategoryFilterProps {
  /** empty set = all categories */
  selected: ReadonlySet<Category>
  onToggle: (c: Category) => void
  onAll: () => void
  counts: Partial<Record<Category, number>>
  total: number
  className?: string
}

/** Horizontally scrollable icon + colour chips. Tap toggles a category; "All" clears the filter. */
export const CategoryFilter = memo(function CategoryFilter({
  selected, onToggle, onAll, counts, total, className,
}: CategoryFilterProps) {
  const { t, lang } = useI18n()
  const allActive = selected.size === 0
  return (
    <div
      role="toolbar"
      aria-label={t('map.filterLabel')}
      className={clsx('awaaz-no-scrollbar flex gap-2 overflow-x-auto px-3 py-1', className)}
    >
      <button
        type="button"
        aria-pressed={allActive}
        onClick={onAll}
        className={clsx(
          'inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full ps-1.5 pe-3.5 text-sm font-bold shadow-sm transition active:scale-95',
          allActive ? 'bg-brand-700 text-white' : 'bg-white/95 text-ink',
        )}
      >
        <span className={clsx('inline-flex size-9 items-center justify-center rounded-full', allActive ? 'bg-white/20' : 'bg-brand-100 text-brand-700')}>
          <LayoutGrid className="size-5" />
        </span>
        {t('map.all')}
        <span className="font-latin text-xs opacity-80">{total}</span>
      </button>
      {CATEGORIES.map((c) => {
        const m = CATEGORY_META[c]
        const Icon = m.icon
        const on = selected.has(c)
        const n = counts[c] ?? 0
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(c)}
            className={clsx(
              'inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full ps-1.5 pe-3.5 text-sm font-bold shadow-sm transition active:scale-95',
              !on && 'bg-white/95 text-ink',
              !on && n === 0 && 'opacity-70',
            )}
            style={on ? { background: m.color, color: '#fff' } : undefined}
          >
            <span
              className="inline-flex size-9 items-center justify-center rounded-full"
              style={on ? { background: 'rgba(255,255,255,0.22)' } : { background: m.color, color: '#fff' }}
            >
              <Icon className="size-5" />
            </span>
            {lang === 'ur' ? m.ur : m.en}
            {n > 0 && <span className="font-latin text-xs opacity-80">{n}</span>}
          </button>
        )
      })}
    </div>
  )
})
