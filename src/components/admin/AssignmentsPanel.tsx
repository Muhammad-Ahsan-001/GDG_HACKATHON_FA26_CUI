import clsx from 'clsx'
import { BellRing, Building2, CheckCheck, Hand, Lock, Navigation, SquareKanban, Wrench, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { adminApi, type AdminAssignment } from '../../lib/adminApi'
import { useI18n } from '../../lib/i18n'
import { ASSIGNMENT_META } from '../../lib/status'
import type { AssignmentStatus } from '../../lib/types'
import { ORG_TYPE_META } from '../auth/meta'
import { CategoryIcon, UrgencyBadge, useTimeAgo } from '../ui'
import { useAdmin, useAsync } from './context'
import { Card, Confidence, Empty, ErrorState, PanelHeader, Skeleton } from './parts'

const COLS: { s: AssignmentStatus; icon: LucideIcon }[] = [
  { s: 'alerted', icon: BellRing },
  { s: 'claimed', icon: Hand },
  { s: 'in_progress', icon: Wrench },
  { s: 'resolved', icon: CheckCheck },
]

function stamp(a: AdminAssignment): string {
  return a.resolved_at ?? a.in_progress_at ?? a.claimed_at ?? a.alerted_at
}

function AssignmentCard({ a, flash }: { a: AdminAssignment; flash: boolean }) {
  const { t, pick } = useI18n()
  const { go } = useAdmin()
  const ago = useTimeAgo()
  const om = ORG_TYPE_META[a.org_type]
  const OrgIcon = om?.icon ?? Building2
  return (
    <li>
      <button type="button" onClick={() => go(a.is_private ? 'sos' : 'reports', a.is_private ? undefined : { search: a.cluster_id })}
        className={clsx('w-full rounded-xl bg-white p-3 text-start shadow-[0_1px_2px_rgb(15_23_42/0.05)] ring-1 transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0',
          a.is_private ? 'ring-red-200' : 'ring-slate-200', flash && 'adm-flash')}>
        <div className="flex items-start gap-2.5">
          <CategoryIcon category={a.category} size={30} />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-sm font-semibold leading-snug text-slate-800">
              {a.is_private && <Lock className="me-1 inline size-3.5 text-red-600" />}
              {pick(a.title_en, a.title_ur) || '—'}
            </div>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-white" style={{ background: om?.color ?? '#475569' }}><OrgIcon className="size-3" /></span>
          <span className="truncate font-semibold">{a.org_name}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
          <UrgencyBadge urgency={a.urgency} />
          {typeof a.distance_m === 'number' && (
            <span className="font-latin inline-flex items-center gap-0.5"><Navigation className="size-3" />
              {a.distance_m >= 1000 ? t('common.km', { n: (a.distance_m / 1000).toFixed(1) }) : t('common.m', { n: Math.round(a.distance_m) })}
            </span>
          )}
          <Confidence value={a.confidence} />
          <span className="ms-auto">{ago(stamp(a))}</span>
        </div>
        {a.claimed_by_name && a.status !== 'alerted' && <div className="mt-1.5 truncate text-[11px] text-slate-400">{t('admin.asg_by', { name: a.claimed_by_name })}</div>}
      </button>
    </li>
  )
}

export default function AssignmentsPanel() {
  const { t, lang } = useI18n()
  const { version, changed } = useAdmin()
  const { data, error, loading, reload } = useAsync(() => adminApi.listAssignments(undefined, 400), [version])
  const byStatus = useMemo(() => {
    const out: Record<AssignmentStatus, AdminAssignment[]> = { alerted: [], claimed: [], in_progress: [], resolved: [] }
    for (const a of data?.rows ?? []) out[a.status]?.push(a)
    for (const k of Object.keys(out) as AssignmentStatus[]) out[k].sort((x, y) => stamp(y).localeCompare(stamp(x)))
    return out
  }, [data])

  return (
    <div>
      <PanelHeader title={t('admin.asg_title')} sub={t('admin.asg_sub')} icon={SquareKanban}
        actions={data ? <span className="font-latin rounded-full bg-white px-3 py-1.5 text-sm font-bold text-slate-700 ring-1 ring-slate-200">{t('admin.asg_total', { n: data.total })}</span> : undefined} />
      {error && !data ? <Card><ErrorState error={error} onRetry={reload} /></Card> : (
        <div className="adm-scroll -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-3 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible">
          {COLS.map(({ s, icon: Icon }) => {
            const m = ASSIGNMENT_META[s]
            const list = byStatus[s]
            return (
              <section key={s} className="flex w-[82vw] max-w-[340px] shrink-0 snap-start flex-col rounded-2xl bg-gradient-to-b from-white/80 to-slate-100/70 ring-1 ring-slate-200/70 lg:w-auto lg:max-w-none">
                <header className="flex items-center gap-2 px-3 pb-2 pt-3">
                  <span className="inline-flex size-7 items-center justify-center rounded-lg text-white" style={{ background: m.color }}><Icon className="size-4" /></span>
                  <h2 className="flex-1 text-sm font-bold text-slate-800">{lang === 'ur' ? m.ur : m.en}</h2>
                  <span className="font-latin rounded-full bg-white px-2 py-0.5 text-xs font-bold tabular-nums text-slate-600 ring-1 ring-slate-200">{loading ? '…' : list.length}</span>
                </header>
                <div className="h-0.5 mx-3 rounded-full" style={{ background: m.color, opacity: 0.35 }} />
                <ul className="adm-scroll flex-1 space-y-2 overflow-y-auto p-2 lg:max-h-[calc(100dvh-15rem)]">
                  {loading ? Array.from({ length: 3 }, (_, i) => <li key={i}><Skeleton className="h-28 rounded-xl" /></li>) :
                    list.length === 0 ? <li><Empty title={t('admin.asg_empty')} /></li> :
                      list.map((a) => <AssignmentCard key={a.id} a={a} flash={changed.has(a.id) || changed.has(a.cluster_id)} />)}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
