import clsx from 'clsx'
import {
  Activity, BadgeCheck, BellRing, Building2, Camera, CheckCheck, FileText, Hand, Hourglass, LayoutDashboard, Lock, MapPin,
  MessageSquareText, Mic, Send, ShieldBan, Siren, Timer, Users, Wrench, type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { adminApi, type AdminActivity, type AdminOverview } from '../../lib/adminApi'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { ASSIGNMENT_META, STATUS_META } from '../../lib/status'
import { CATEGORIES, type Category, type ReportStatus, type Role } from '../../lib/types'
import { ORG_TYPE_META, ROLE_META } from '../auth/meta'
import { AiLabel, CategoryIcon, useTimeAgo } from '../ui'
import { fmtMinutes, useAdmin, useAsync, type Section } from './context'
import { AnimatedNumber, Card, Empty, ErrorState, PanelHeader, Skeleton, SkeletonRows } from './parts'
import { ReportsChart } from './ReportsChart'

const STATUSES: ReportStatus[] = ['unconfirmed', 'verified', 'disputed', 'in_progress', 'resolved']
const ROLES: Role[] = ['citizen', 'ngo', 'responder', 'admin']

function Kpi({ icon: Icon, label, value, sub, tone, onClick, alert, format }: {
  icon: LucideIcon; label: string; value: number; sub?: string; tone: string; onClick?: () => void; alert?: boolean
  format?: (n: number) => string
}) {
  return (
    <button type="button" onClick={onClick}
      className={clsx(
        'group relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-2xl bg-white p-4 text-start shadow-[0_1px_2px_rgb(15_23_42/0.04)] ring-1 transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        alert ? 'ring-red-200' : 'ring-slate-200/80',
      )}>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `${tone}14`, color: tone }}>
          <Icon className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-600">{label}</span>
        {alert && <span className="adm-live-dot text-red-500" />}
      </div>
      <div>
        <AnimatedNumber value={value} format={format} className="block text-[28px] font-black leading-none tracking-tight text-slate-900" />
        {sub && <div className="mt-1.5 truncate text-xs text-slate-500">{sub}</div>}
      </div>
    </button>
  )
}

function KpiGrid({ o }: { o: AdminOverview }) {
  const { t } = useI18n()
  const { go } = useAdmin()
  const spamPct = o.reports.total ? Math.round((o.reports.spam / o.reports.total) * 100) : 0
  const openAlerts = o.assignments.by_status.alerted + o.assignments.by_status.claimed + o.assignments.by_status.in_progress
  const tiles: { key: string; icon: LucideIcon; label: string; value: number; sub: string; tone: string; to: Section; alert?: boolean }[] = [
    { key: 'r', icon: FileText, label: t('admin.kpi_reports'), value: o.reports.total, sub: t('admin.kpi_reportsSub', { n: o.reports.today }), tone: '#0F766E', to: 'reports' },
    { key: 'o', icon: MapPin, label: t('admin.kpi_open'), value: o.clusters.open, sub: t('admin.kpi_openSub', { n: o.clusters.total }), tone: '#1D4ED8', to: 'map' },
    { key: 'a', icon: BellRing, label: t('admin.kpi_alerts'), value: openAlerts, sub: t('admin.kpi_alertsSub', { n: o.assignments.by_status.resolved }), tone: '#DC2626', to: 'assignments' },
    { key: 's', icon: Siren, label: t('admin.kpi_sos'), value: o.sos.total, sub: t('admin.kpi_sosSub', { n: o.sos.active }), tone: '#7C3AED', to: 'sos', alert: o.sos.active > 0 },
    { key: 'u', icon: Users, label: t('admin.kpi_users'), value: o.users.total, sub: t('admin.kpi_usersSub', { n: o.users.active_today }), tone: '#0891B2', to: 'users' },
    { key: 'g', icon: Building2, label: t('admin.kpi_orgs'), value: o.orgs.total, sub: o.orgs.pending ? t('admin.kpi_orgsSub', { n: o.orgs.pending }) : t('admin.kpi_orgsOk'), tone: '#B45309', to: 'orgs', alert: o.orgs.pending > 0 },
    { key: 'n', icon: Send, label: t('admin.kpi_notif'), value: o.notifications.today, sub: t('admin.kpi_notifSub', { n: o.notifications.total }), tone: '#DB2777', to: 'notifications' },
    { key: 'x', icon: ShieldBan, label: t('admin.kpi_spam'), value: o.reports.spam, sub: t('admin.kpi_spamSub', { n: spamPct }), tone: '#475569', to: 'reports' },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((k) => (
        <Kpi key={k.key} icon={k.icon} label={k.label} value={k.value} sub={k.sub} tone={k.tone} alert={k.alert}
          onClick={() => go(k.to, k.key === 'x' ? { search: '' } : undefined)} />
      ))}
    </div>
  )
}

function Bar({ pct, color, delay = 0 }: { pct: number; color: string; delay?: number }) {
  const reduce = useReducedMotion()
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
      <motion.div className="h-full rounded-full" style={{ background: color }}
        initial={reduce ? false : { width: 0 }} animate={{ width: `${Math.max(pct > 0 ? 3 : 0, pct)}%` }}
        transition={{ duration: reduce ? 0 : 0.6, delay: reduce ? 0 : delay, ease: [0.22, 1, 0.36, 1] }} />
    </div>
  )
}

function CategoryBreakdown({ o }: { o: AdminOverview }) {
  const { t, lang } = useI18n()
  const rows = CATEGORIES.map((c) => ({ c, n: o.clusters.by_category[c] ?? 0 })).sort((a, b) => b.n - a.n)
  const max = Math.max(1, ...rows.map((r) => r.n))
  return (
    <Card title={t('admin.byCategory')} icon={LayoutDashboard}>
      <ul className="space-y-2.5">
        {rows.map(({ c, n }, i) => (
          <li key={c} className="flex items-center gap-2.5">
            <CategoryIcon category={c as Category} size={26} />
            <span className="w-16 shrink-0 truncate text-sm font-semibold text-slate-700">{lang === 'ur' ? CATEGORY_META[c].ur : CATEGORY_META[c].en}</span>
            <Bar pct={(n / max) * 100} color={CATEGORY_META[c].color} delay={i * 0.04} />
            <span className="font-latin w-7 text-end text-sm font-bold tabular-nums text-slate-900">{n}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function StatusBreakdown({ o }: { o: AdminOverview }) {
  const { t, lang } = useI18n()
  const total = STATUSES.reduce((s, k) => s + (o.clusters.by_status[k] ?? 0), 0)
  return (
    <Card title={t('admin.byStatus')} icon={Activity}>
      <div className="mb-4 flex h-3 gap-[2px] overflow-hidden rounded-full bg-slate-100" role="img"
        aria-label={STATUSES.map((s) => `${STATUS_META[s].en}: ${o.clusters.by_status[s] ?? 0}`).join(', ')}>
        {total > 0 && STATUSES.map((s) => {
          const n = o.clusters.by_status[s] ?? 0
          return n ? <div key={s} className="h-full first:rounded-s-full last:rounded-e-full" style={{ width: `${(n / total) * 100}%`, background: STATUS_META[s].color }} /> : null
        })}
      </div>
      <ul className="space-y-2">
        {STATUSES.map((s) => {
          const m = STATUS_META[s]
          const Icon = m.icon
          const n = o.clusters.by_status[s] ?? 0
          return (
            <li key={s} className="flex items-center gap-2.5 text-sm">
              <span className="inline-flex size-7 items-center justify-center rounded-lg" style={{ background: m.soft, color: m.color }}><Icon className="size-4" /></span>
              <span className="flex-1 font-semibold text-slate-700">{lang === 'ur' ? m.ur : m.en}</span>
              <span className="font-latin text-xs tabular-nums text-slate-400">{total ? Math.round((n / total) * 100) : 0}%</span>
              <span className="font-latin w-7 text-end font-bold tabular-nums text-slate-900">{n}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function ResponseTimes({ o }: { o: AdminOverview }) {
  const { t } = useI18n()
  const r = o.response
  const tiles = [
    { label: t('admin.resp_reportToClaim'), v: r.avg_min_report_to_claim, n: r.claimed_count, icon: Timer, color: '#B45309' },
    { label: t('admin.resp_alertToClaim'), v: r.avg_min_alert_to_claim, n: r.claimed_count, icon: Hand, color: '#1D4ED8' },
    { label: t('admin.resp_claimToResolve'), v: r.avg_min_claim_to_resolve, n: r.resolved_count, icon: CheckCheck, color: '#047857' },
  ]
  const conf = Math.round((o.reports.avg_confidence ?? 0) * 100)
  return (
    <Card title={t('admin.response')} icon={Timer}>
      <div className="grid gap-3 sm:grid-cols-4">
        {tiles.map((x) => {
          const Icon = x.icon
          const val = fmtMinutes(t, x.v)
          return (
            <div key={x.label} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500"><Icon className="size-3.5" style={{ color: x.color }} /> {x.label}</div>
              <div className="font-latin mt-1.5 text-xl font-black tracking-tight text-slate-900">{val ?? '—'}</div>
              <div className="text-[11px] text-slate-400">{val ? t('admin.resp_basis', { n: x.n }) : t('admin.resp_none')}</div>
            </div>
          )
        })}
        <div className="rounded-xl bg-violet-50/60 p-3 ring-1 ring-violet-100">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">{t('admin.avgConfidence')}</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <AnimatedNumber value={conf} format={(n) => `${n}%`} className="text-xl font-black tracking-tight text-slate-900" />
          </div>
          <AiLabel className="mt-1" />
        </div>
      </div>
    </Card>
  )
}

function Hotspots({ o }: { o: AdminOverview }) {
  const { t } = useI18n()
  const max = Math.max(1, ...o.top_areas.map((a) => a.count))
  return (
    <Card title={t('admin.hotspots')} icon={MapPin}>
      {o.top_areas.length === 0 ? <Empty icon={MapPin} title={t('admin.hotspotsEmpty')} /> : (
        <ol className="space-y-2.5">
          {o.top_areas.map((a, i) => (
            <li key={a.area} className="flex items-center gap-2.5 text-sm">
              <span className="font-latin inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-500">{i + 1}</span>
              <span dir="auto" className="font-latin w-0 flex-[1.4] truncate font-semibold text-slate-700" title={a.area}>{a.area}</span>
              <Bar pct={(a.count / max) * 100} color="#0d9488" delay={i * 0.04} />
              <span className="font-latin w-6 text-end font-bold tabular-nums text-slate-900">{a.count}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

function People({ o }: { o: AdminOverview }) {
  const { t } = useI18n()
  const max = Math.max(1, ...ROLES.map((r) => o.users.by_role[r] ?? 0))
  const inputs = [
    { k: 'voice', n: o.reports.voice, icon: Mic },
    { k: 'photo', n: o.reports.photo, icon: Camera },
    { k: 'text', n: o.reports.text, icon: MessageSquareText },
  ]
  const imax = Math.max(1, ...inputs.map((i) => i.n))
  return (
    <Card title={t('admin.byRole')} icon={Users}>
      <ul className="space-y-2.5">
        {ROLES.map((r) => {
          const m = ROLE_META[r]
          const Icon = m.icon
          const n = o.users.by_role[r] ?? 0
          return (
            <li key={r} className="flex items-center gap-2.5 text-sm">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg" style={{ background: m.soft, color: m.color }}><Icon className="size-4" /></span>
              <span className="w-20 shrink-0 truncate font-semibold text-slate-700">{t(`auth.role_${r}`)}</span>
              <Bar pct={(n / max) * 100} color={m.color} />
              <span className="font-latin w-6 text-end font-bold tabular-nums">{n}</span>
            </li>
          )
        })}
      </ul>
      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">{t('admin.inputs')}</div>
        <div className="grid grid-cols-3 gap-2">
          {inputs.map(({ k, n, icon: Icon }) => (
            <div key={k} className="rounded-xl bg-slate-50 p-2.5 text-center ring-1 ring-slate-100">
              <Icon className="mx-auto size-4 text-brand-700" />
              <div className="font-latin mt-1 text-lg font-black tabular-nums">{n}</div>
              <div className="text-[11px] font-semibold text-slate-500">{t(`admin.input_${k}`)}</div>
              <div className="mx-auto mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-brand-600" style={{ width: `${(n / imax) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

const ACT_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  assignment_alerted: { icon: BellRing, color: ASSIGNMENT_META.alerted.color },
  assignment_claimed: { icon: Hand, color: ASSIGNMENT_META.claimed.color },
  assignment_in_progress: { icon: Wrench, color: ASSIGNMENT_META.in_progress.color },
  assignment_resolved: { icon: CheckCheck, color: ASSIGNMENT_META.resolved.color },
  sos_monitoring: { icon: Siren, color: '#7C3AED' },
  sos_alerted: { icon: Siren, color: '#DC2626' },
  sos_safe: { icon: BadgeCheck, color: '#047857' },
  sos_cancelled: { icon: Siren, color: '#64748B' },
  sos_resolved: { icon: CheckCheck, color: '#047857' },
  org_pending: { icon: Hourglass, color: '#B45309' },
  org_approved: { icon: BadgeCheck, color: '#0F766E' },
}

function ActivityFeed() {
  const { t, pick, lang } = useI18n()
  const { version, go, changed } = useAdmin()
  const ago = useTimeAgo()
  const reduce = useReducedMotion()
  const { data, error, loading, reload } = useAsync(() => adminApi.activity(24), [version])

  const label = (a: AdminActivity) => {
    if (a.kind === 'report') return t(a.is_spam ? 'admin.act_report_spam' : 'admin.act_report')
    return t(`admin.act_${a.kind}`, { org: a.org_name ?? '' })
  }
  const open = (a: AdminActivity) => {
    if (a.kind === 'report') go('reports', { search: a.ref_id })
    else if (a.kind.startsWith('assignment')) go('assignments')
    else if (a.kind.startsWith('sos')) go('sos')
    else go('orgs')
  }

  return (
    <Card title={t('admin.activity')} icon={Activity} className="flex flex-col lg:row-span-3 lg:h-0 lg:min-h-full" bodyClass="min-h-0 flex-1 px-2 pb-2"
      action={<AiLabel />}>
      {loading ? <div className="p-2"><SkeletonRows rows={8} /></div> : error ? <ErrorState error={error} onRetry={reload} compact /> :
        !data?.length ? <Empty title={t('admin.activityEmpty')} /> : (
          <ul className="adm-scroll max-h-[560px] overflow-y-auto lg:h-full lg:max-h-none">
            <AnimatePresence initial={false}>
              {data.map((a) => {
                const isOrg = a.kind.startsWith('org')
                const meta = ACT_ICON[a.kind]
                const OrgIcon = isOrg ? ORG_TYPE_META[a.category as keyof typeof ORG_TYPE_META]?.icon : undefined
                const title = isOrg ? a.org_name : pick(a.title_en, a.title_ur) ||
                  (a.category && a.category in CATEGORY_META ? (lang === 'ur' ? CATEGORY_META[a.category as Category].ur : CATEGORY_META[a.category as Category].en) : '')
                return (
                  <motion.li key={`${a.kind}-${a.ref_id}`} layout={!reduce}
                    initial={reduce ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}>
                    <button type="button" onClick={() => open(a)}
                      className={clsx('flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-start hover:bg-slate-50',
                        (changed.has(a.ref_id) || (a.cluster_id && changed.has(a.cluster_id))) && 'adm-flash')}>
                      {a.kind === 'report' && a.category && a.category in CATEGORY_META ? (
                        <CategoryIcon category={a.category as Category} size={32} />
                      ) : (
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full"
                          style={{ background: `${meta?.color ?? '#475569'}18`, color: meta?.color ?? '#475569' }}>
                          {(() => { const I = OrgIcon ?? meta?.icon ?? Activity; return <I className="size-4" /> })()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-900">{title || label(a)}</span>
                        <span className="flex items-center gap-1.5 text-xs text-slate-500">
                          <span className="truncate">{label(a)}</span>
                          {a.is_private && <Lock className="size-3 shrink-0 text-violet-600" aria-label={t('admin.private')} />}
                          <span aria-hidden>·</span>
                          <span className="shrink-0">{ago(a.at)}</span>
                        </span>
                      </span>
                    </button>
                  </motion.li>
                )
              })}
            </AnimatePresence>
          </ul>
        )}
    </Card>
  )
}

export default function OverviewPanel() {
  const { t } = useI18n()
  const { overview: o, overviewError, refresh } = useAdmin()

  return (
    <div>
      <PanelHeader title={t('admin.ov_title')} sub={t('admin.ov_sub')} icon={LayoutDashboard} />
      {!o && overviewError ? (
        <Card><ErrorState error={overviewError} onRetry={refresh} /></Card>
      ) : !o ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)}</div>
          <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-80 rounded-2xl lg:col-span-2" /><Skeleton className="h-80 rounded-2xl" /></div>
        </div>
      ) : (
        <div className="space-y-4">
          <KpiGrid o={o} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={t('admin.chart_title')} icon={FileText} className="lg:col-span-2"><ReportsChart data={o.per_day} /></Card>
            <ActivityFeed />
            <div className="lg:col-span-2"><ResponseTimes o={o} /></div>
            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
              <CategoryBreakdown o={o} />
              <StatusBreakdown o={o} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Hotspots o={o} />
            <People o={o} />
          </div>
        </div>
      )}
    </div>
  )
}
