import clsx from 'clsx'
import { Bell, BellOff, BellRing, CheckCheck, Circle, RefreshCcw, Siren, Utensils, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { adminApi } from '../../lib/adminApi'
import { useI18n } from '../../lib/i18n'
import { ROLE_META } from '../auth/meta'
import { useTimeAgo } from '../ui'
import { fmtDateTime, useAdmin, useAsync } from './context'
import { Card, Chip, Empty, ErrorState, Pager, PanelHeader, SkeletonRows } from './parts'

const TYPE_META: Record<string, { icon: LucideIcon; color: string }> = {
  new_assignment: { icon: BellRing, color: '#DC2626' },
  status_change: { icon: RefreshCcw, color: '#2563EB' },
  nearby_alert: { icon: Bell, color: '#EA580C' },
  food_alert: { icon: Utensils, color: '#16A34A' },
  verified: { icon: CheckCheck, color: '#15803D' },
  sos_alert: { icon: Siren, color: '#DC2626' },
  sos_logged: { icon: Siren, color: '#7C3AED' },
}
const LIMIT = 40

export default function NotificationsPanel() {
  const { t, pick } = useI18n()
  const { version } = useAdmin()
  const ago = useTimeAgo()
  const [type, setType] = useState('all')
  const [offset, setOffset] = useState(0)
  useEffect(() => { setOffset(0) }, [type])
  const { data, error, loading, reload } = useAsync(() => adminApi.listNotifications(type, LIMIT, offset), [type, offset, version])
  const rows = data?.rows ?? []
  const types = Object.entries(data?.types ?? {}).sort((a, b) => b[1] - a[1])
  const total = Object.values(data?.types ?? {}).reduce((s, n) => s + n, 0)
  const typeLabel = (k: string) => { const s = t(`admin.type_${k}`); return s.startsWith('admin.') ? k : s }

  return (
    <div>
      <PanelHeader title={t('admin.ntf_title')} icon={Bell} sub={data ? t('admin.ntf_sub', { n: total }) : undefined} />
      <div className="adm-scroll -mx-3 mb-3 flex gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <Chip active={type === 'all'} onClick={() => setType('all')} count={total}>{t('admin.ntf_all')}</Chip>
        {types.map(([k, n]) => (
          <Chip key={k} active={type === k} icon={TYPE_META[k]?.icon ?? Bell} color={TYPE_META[k]?.color} count={n} onClick={() => setType(k)}>{typeLabel(k)}</Chip>
        ))}
      </div>
      <Card bodyClass="p-0" className="overflow-hidden">
        {loading ? <div className="p-4"><SkeletonRows rows={8} /></div> : error ? <ErrorState error={error} onRetry={reload} /> :
          rows.length === 0 ? <Empty icon={BellOff} title={t('admin.ntf_empty')} /> : (
            <>
              <ul className="divide-y divide-slate-100">
                {rows.map((n) => {
                  const m = TYPE_META[n.type] ?? { icon: Bell, color: '#475569' }
                  const I = m.icon
                  const role = n.user_role ? ROLE_META[n.user_role] : null
                  return (
                    <li key={n.id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50/60">
                      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `${m.color}14`, color: m.color }}><I className="size-4.5" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="font-semibold text-slate-800">{pick(n.title_en, n.title_ur) || typeLabel(n.type)}</span>
                          <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: `${m.color}14`, color: m.color }}>{typeLabel(n.type)}</span>
                        </div>
                        {pick(n.body_en, n.body_ur) && <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{pick(n.body_en, n.body_ur)}</p>}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            {role && <role.icon className="size-3.5" style={{ color: role.color }} />}
                            <span className="font-semibold text-slate-700">{n.user_name || n.user_email || n.user_id.slice(0, 8)}</span>
                            {n.user_role && <span>· {t(`auth.role_${n.user_role}`)}</span>}
                          </span>
                          <span title={fmtDateTime(n.created_at)}>{ago(n.created_at)}</span>
                        </div>
                      </div>
                      <span className={clsx('mt-1 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold',
                        n.read_at ? 'bg-slate-100 text-slate-500' : 'bg-brand-50 text-brand-700')}>
                        {n.read_at ? <CheckCheck className="size-3" /> : <Circle className="size-2.5 fill-current" />}
                        {t(n.read_at ? 'admin.read' : 'admin.unread')}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <Pager offset={offset} limit={LIMIT} total={data?.total ?? 0} onChange={setOffset} />
            </>
          )}
      </Card>
    </div>
  )
}
