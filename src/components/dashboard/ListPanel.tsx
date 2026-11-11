import clsx from 'clsx'
import { Bell, CheckCheck, Inbox, LayoutGrid, Wrench, type LucideIcon } from 'lucide-react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { ASSIGNMENT_META } from '../../lib/status'
import type { Category } from '../../lib/types'
import { EmptyState, Spinner } from '../ui'
import { AssignmentCard } from './AssignmentCard'
import type { AssignmentActionKind, CategoryFilter, DashAssignment, DashTab } from './types'

const TABS: { tab: DashTab; key: string; icon: LucideIcon; color: string }[] = [
  { tab: 'new', key: 'dashboard.tabNew', icon: Bell, color: ASSIGNMENT_META.alerted.color },
  { tab: 'active', key: 'dashboard.tabActive', icon: Wrench, color: ASSIGNMENT_META.in_progress.color },
  { tab: 'done', key: 'dashboard.tabDone', icon: CheckCheck, color: ASSIGNMENT_META.resolved.color },
]

const EMPTY: Record<DashTab, { title: string; body: string }> = {
  new: { title: 'dashboard.emptyNew', body: 'dashboard.emptyNewBody' },
  active: { title: 'dashboard.emptyActive', body: 'dashboard.emptyActiveBody' },
  done: { title: 'dashboard.emptyDone', body: 'dashboard.emptyDoneBody' },
}

export interface ListPanelProps {
  tab: DashTab
  onTab: (tab: DashTab) => void
  counts: Record<DashTab, number>
  /** tabs with an unseen new alert pulse */
  attention: ReadonlySet<DashTab>
  category: CategoryFilter
  onCategory: (c: CategoryFilter) => void
  /** categories present in the data, with counts for the current tab */
  categoryCounts: Partial<Record<Category, number>>
  items: DashAssignment[]
  loading: boolean
  error: string | null
  onRetry: () => void
  selectedId: string | null
  highlightIds: ReadonlySet<string>
  pending: ReadonlySet<string>
  showOrg: boolean
  onSelect: (a: DashAssignment) => void
  onAction: (a: DashAssignment, action: AssignmentActionKind) => void
}

export function ListPanel(p: ListPanelProps) {
  const { t, lang } = useI18n()
  const presentCats = (Object.keys(p.categoryCounts) as Category[])
    .sort((a, b) => Object.keys(CATEGORY_META).indexOf(a) - Object.keys(CATEGORY_META).indexOf(b))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Status tabs */}
      <div role="tablist" className="grid grid-cols-3 gap-1.5 border-b border-slate-200 bg-white px-3 py-2">
        {TABS.map(({ tab, key, icon: Icon, color }) => {
          const active = p.tab === tab
          return (
            <button
              key={tab}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => p.onTab(tab)}
              className={clsx(
                'relative inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl px-2 text-sm font-bold transition',
                active ? 'text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
              )}
              style={active ? { background: color } : undefined}
            >
              <Icon className="size-5 shrink-0" />
              <span className="truncate">{t(key)}</span>
              <span
                className={clsx(
                  'font-latin inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-extrabold',
                  active ? 'bg-white/25 text-white' : 'bg-white text-slate-700',
                )}
              >
                {p.counts[tab]}
              </span>
              {p.attention.has(tab) && !active && (
                <span aria-hidden className="awaaz-dash-blink absolute -top-1 -end-1 size-3.5 rounded-full border-2 border-white bg-red-600" />
              )}
            </button>
          )
        })}
      </div>

      {/* Category chips */}
      {presentCats.length > 0 && (
        <div className="awaaz-dash-scroll flex gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2">
          <Chip
            active={p.category === 'all'}
            onClick={() => p.onCategory('all')}
            label={t('dashboard.allCategories')}
            icon={LayoutGrid}
            color="#0f172a"
          />
          {presentCats.map((c) => {
            const m = CATEGORY_META[c]
            return (
              <Chip
                key={c}
                active={p.category === c}
                onClick={() => p.onCategory(p.category === c ? 'all' : c)}
                label={lang === 'ur' ? m.ur : m.en}
                icon={m.icon}
                color={m.color}
                count={p.categoryCounts[c]}
              />
            )
          })}
        </div>
      )}

      {/* Cards */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-slate-50 p-3">
        {p.loading ? (
          <div className="flex justify-center p-10 text-brand-700"><Spinner className="size-9" /></div>
        ) : p.error ? (
          <EmptyState icon={Inbox} title={t('dashboard.loadError')}>
            <button type="button" onClick={p.onRetry}
              className="mt-2 min-h-12 rounded-2xl bg-brand-700 px-5 font-bold text-white hover:bg-brand-900">
              {t('common.retry')}
            </button>
          </EmptyState>
        ) : p.items.length === 0 ? (
          <EmptyState icon={TABS.find((x) => x.tab === p.tab)?.icon ?? Inbox} title={t(EMPTY[p.tab].title)}>
            <p className="text-sm">{t(EMPTY[p.tab].body)}</p>
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {p.items.map((a) => (
              <li key={a.assignment_id}>
                <AssignmentCard
                  a={a}
                  selected={p.selectedId === a.assignment_id}
                  highlighted={p.highlightIds.has(a.assignment_id)}
                  pending={p.pending.has(a.assignment_id)}
                  showOrg={p.showOrg}
                  onSelect={p.onSelect}
                  onAction={p.onAction}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Chip({ active, onClick, label, icon: Icon, color, count }: {
  active: boolean; onClick: () => void; label: string; icon: LucideIcon; color: string; count?: number
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={label}
      className={clsx(
        'inline-flex min-h-12 shrink-0 items-center gap-1.5 rounded-full border-2 px-3 text-sm font-bold transition',
        active ? 'text-white' : 'bg-white text-slate-700 hover:bg-slate-50',
      )}
      style={active ? { background: color, borderColor: color } : { borderColor: `${color}55` }}
    >
      <Icon className="size-5" style={active ? undefined : { color }} />
      <span>{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span className={clsx('font-latin rounded-full px-1.5 text-xs', active ? 'bg-white/25' : 'bg-slate-100')}>{count}</span>
      )}
    </button>
  )
}
