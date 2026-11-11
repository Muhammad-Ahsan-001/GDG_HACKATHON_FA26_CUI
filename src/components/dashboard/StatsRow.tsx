import clsx from 'clsx'
import { Bell, CheckCheck, Hand, Timer, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { ASSIGNMENT_META } from '../../lib/status'
import type { DashTab } from './types'
import { formatDuration } from './utils'

type Stats = Awaited<ReturnType<typeof api.dashboardStats>>

export interface StatsRowProps {
  /** null = all of the caller's orgs (admin: all orgs) */
  orgId: string | null
  /** bump to refetch (e.g. after every realtime-driven reload) */
  refreshKey: number
  onPickTab?: (tab: DashTab) => void
}

interface Tile {
  key: string
  label: string
  value: string
  icon: LucideIcon
  color: string
  tab?: DashTab
}

/** Header counters from the `dashboard_stats` RPC. Tiles double as shortcuts to the matching tab. */
export function StatsRow({ orgId, refreshKey, onPickTab }: StatsRowProps) {
  const { t } = useI18n()
  const [stats, setStats] = useState<Stats | null>(null)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const lastOrg = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (lastOrg.current !== orgId) {
      lastOrg.current = orgId
      setStats(null)
    }
    const mine = ++seq.current
    // small delay coalesces bursts of realtime refreshes into one RPC
    const timer = window.setTimeout(() => {
      api.dashboardStats(orgId ?? undefined)
        .then((s) => { if (mine === seq.current) { setStats(s); setFailed(false) } })
        .catch(() => { if (mine === seq.current) setFailed(true) })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [orgId, refreshKey])

  const num = (n: number | null | undefined) => (stats ? String(n ?? 0) : '–')
  const avg = stats?.avg_minutes_to_claim
  const tiles: Tile[] = [
    { key: 'open', label: t('dashboard.statOpen'), value: num(stats?.open), icon: Bell, color: ASSIGNMENT_META.alerted.color, tab: 'new' },
    { key: 'claimed', label: t('dashboard.statClaimed'), value: num(stats?.claimed), icon: Hand, color: ASSIGNMENT_META.claimed.color, tab: 'active' },
    { key: 'progress', label: t('dashboard.statInProgress'), value: num(stats?.in_progress), icon: Wrench, color: ASSIGNMENT_META.in_progress.color, tab: 'active' },
    { key: 'resolved', label: t('dashboard.statResolvedToday'), value: num(stats?.resolved_today), icon: CheckCheck, color: ASSIGNMENT_META.resolved.color, tab: 'done' },
    {
      key: 'avg', label: t('dashboard.statAvgClaim'),
      value: !stats ? '–' : avg == null ? '—' : formatDuration(Number(avg) * 60_000, t),
      icon: Timer, color: '#475569',
    },
  ]

  return (
    <div className="awaaz-dash-scroll flex gap-2 overflow-x-auto px-3 py-2 lg:grid lg:grid-cols-5 lg:overflow-visible" aria-live="polite">
      {tiles.map((tile) => {
        const Icon = tile.icon
        const body = (
          <>
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white" style={{ background: tile.color }}>
              <Icon className="size-5" />
            </span>
            <span className="min-w-0 text-start">
              <span className={clsx('font-latin block text-xl font-extrabold leading-tight', failed && !stats && 'text-slate-400')} style={{ color: stats ? tile.color : undefined }}>
                {tile.value}
              </span>
              <span className="block truncate text-xs font-semibold text-slate-600">{tile.label}</span>
            </span>
          </>
        )
        const cls = 'flex min-h-14 min-w-[9.5rem] shrink-0 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 lg:min-w-0'
        return tile.tab && onPickTab ? (
          <button key={tile.key} type="button" onClick={() => onPickTab(tile.tab!)} className={clsx(cls, 'hover:bg-slate-50 active:scale-[0.98]')}>
            {body}
          </button>
        ) : (
          <div key={tile.key} className={cls}>{body}</div>
        )
      })}
    </div>
  )
}
