import clsx from 'clsx'
import { CircleCheck, CircleDashed, Ghost, MapPin, Siren, UserSearch, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { adminApi, type AdminUser } from '../../lib/adminApi'
import { useI18n } from '../../lib/i18n'
import type { Role } from '../../lib/types'
import { ROLE_META } from '../auth/meta'
import { useTimeAgo } from '../ui'
import { useAdmin, useAsync } from './context'
import { Avatar, Card, Chip, Empty, ErrorState, Pager, PanelHeader, Select, SkeletonRows } from './parts'

const ROLES: Role[] = ['citizen', 'ngo', 'responder', 'admin']
const LIMIT = 30

function TrustSlider({ u, onSaved }: { u: AdminUser; onSaved: (v: number) => void }) {
  const { t } = useI18n()
  const { toast } = useAdmin()
  const [v, setV] = useState(u.trust_score)
  const saved = useRef(u.trust_score)
  useEffect(() => { setV(u.trust_score); saved.current = u.trust_score }, [u.trust_score])
  // save once the slider settles
  useEffect(() => {
    if (Math.abs(v - saved.current) < 0.001) return
    const h = setTimeout(() => {
      adminApi.setTrust(u.id, v).then(
        (r) => {
          saved.current = r.trust_score
          onSaved(r.trust_score)
          toast(t('admin.trustToast', { name: u.display_name || u.email || '', n: Math.round(r.trust_score * 100) }))
        },
        (e: unknown) => { setV(saved.current); toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error') },
      )
    }, 650)
    return () => clearTimeout(h)
  }, [v, u.id, u.display_name, u.email, onSaved, toast, t])
  const pct = Math.round(v * 100)
  const fill = v >= 0.7 ? '#15803D' : v >= 0.4 ? '#B45309' : '#B91C1C'
  return (
    <div className="flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
      <input type="range" min={0} max={1} step={0.05} value={v} onChange={(e) => setV(Number(e.target.value))}
        aria-label={t('admin.trustLabel', { name: u.display_name || u.email || '' })}
        className="adm-range w-24 sm:w-28" style={{ ['--fill' as string]: fill, ['--p' as string]: `${pct}%` }} />
      <span className="font-latin w-9 text-xs font-bold tabular-nums" style={{ color: fill }}>{pct}%</span>
    </div>
  )
}

export default function UsersPanel() {
  const { t } = useI18n()
  const { search, version, toast, overview } = useAdmin()
  const { session } = useAuth()
  const ago = useTimeAgo()
  const [role, setRole] = useState<string>('all')
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { setOffset(0) }, [search, role])

  const { data, setData, error, loading, reload } = useAsync(() => adminApi.listUsers({ search, role, limit: LIMIT, offset }), [search, role, offset, version])
  const rows = data?.rows ?? []
  const me = session?.user.id

  const patch = (id: string, p: Partial<AdminUser>) => setData((d) => d && { ...d, rows: d.rows.map((u) => (u.id === id ? { ...u, ...p } : u)) })
  const changeRole = async (u: AdminUser, r: Role) => {
    setBusy(u.id)
    try {
      await adminApi.setRole(u.id, r)
      patch(u.id, { role: r })
      toast(t('admin.roleToast', { name: u.display_name || u.email || '', role: t(`auth.role_${r}`) }))
    } catch (e) {
      const msg = (e as Error).message
      toast(/cannot_change_self/.test(msg) ? t('admin.cantSelf') : `${t('admin.saveFailed')}: ${msg}`, 'error')
    } finally { setBusy(null) }
  }

  const name = (u: AdminUser) => u.display_name || (u.is_anonymous ? t('admin.anonymous') : t('admin.unnamed'))
  const contact = (u: AdminUser) => u.email || u.phone || u.auth_phone || u.id.slice(0, 8)
  const roleSelect = (u: AdminUser) => {
    const m = ROLE_META[u.role]
    return (
      <Select aria-label={t('admin.roleLabel', { name: name(u) })} value={u.role} disabled={u.id === me || busy === u.id}
        onChange={(e) => { void changeRole(u, e.target.value as Role) }} className="!min-h-8 text-xs" style={{ color: m.color }}
        title={u.id === me ? t('admin.cantSelf') : undefined}>
        {ROLES.map((r) => <option key={r} value={r}>{t(`auth.role_${r}`)}</option>)}
      </Select>
    )
  }
  const badges = (u: AdminUser) => (
    <>
      {u.id === me && <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-900">{t('admin.you')}</span>}
      {u.is_demo && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{t('admin.demo')}</span>}
      {u.is_anonymous && <Ghost className="size-3.5 text-slate-400" aria-label={t('admin.anonymous')} />}
    </>
  )

  return (
    <div>
      <PanelHeader title={t('admin.usr_title')} icon={Users} sub={data ? t('admin.usr_sub', { n: data.total }) : undefined} />
      <div className="adm-scroll -mx-3 mb-3 flex gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <Chip active={role === 'all'} onClick={() => setRole('all')} count={overview?.users.total}>{t('admin.map_all')}</Chip>
        {ROLES.map((r) => (
          <Chip key={r} active={role === r} icon={ROLE_META[r].icon} color={ROLE_META[r].color} onClick={() => setRole(r)} count={overview?.users.by_role[r]}>
            {t(`auth.role_${r}`)}
          </Chip>
        ))}
        <Chip active={role === 'anonymous'} icon={Ghost} onClick={() => setRole('anonymous')} count={overview?.users.anonymous}>{t('admin.anonymous')}</Chip>
      </div>

      <Card bodyClass="p-0" className="overflow-hidden">
        {loading ? <div className="p-4"><SkeletonRows rows={8} /></div> : error ? <ErrorState error={error} onRetry={reload} /> :
          rows.length === 0 ? <Empty icon={UserSearch} title={t('admin.usr_empty')} /> : (
            <>
              <div className="adm-scroll hidden overflow-x-auto md:block">
                <table className="w-full min-w-[920px] text-sm">
                  <thead className="bg-slate-50/80 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-start font-semibold">{t('admin.col_person')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_role')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_trust')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_reports')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_area')}</th>
                      <th className="px-4 py-2.5 text-start font-semibold">{t('admin.col_lastSeen')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => {
                      const m = ROLE_META[u.role]
                      return (
                        <tr key={u.id} className="border-t border-slate-100 hover:bg-brand-50/40">
                          <td className="max-w-[300px] px-4 py-2.5">
                            <div className="flex items-center gap-3">
                              <Avatar name={u.display_name} color={m.color} soft={m.soft} icon={m.icon} />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 font-semibold text-slate-800"><span className="truncate">{name(u)}</span>{badges(u)}</div>
                                <div dir="ltr" className="font-latin truncate text-start text-xs text-slate-500">{contact(u)}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">{roleSelect(u)}</td>
                          <td className="px-3 py-2.5"><TrustSlider u={u} onSaved={(v) => patch(u.id, { trust_score: v })} /></td>
                          <td className="px-3 py-2.5">
                            <span className="font-latin font-bold tabular-nums text-slate-800">{u.report_count}</span>
                            {u.spam_count > 0 && <span className="ms-1.5 text-xs text-red-600">{t('admin.nSpam', { n: u.spam_count })}</span>}
                            {u.sos_count > 0 && <span className="ms-1.5 inline-flex items-center gap-0.5 text-xs text-violet-700"><Siren className="size-3" />{u.sos_count}</span>}
                          </td>
                          <td className="max-w-[180px] px-3 py-2.5">
                            {u.home_area ? <span dir="auto" className="inline-flex items-center gap-1 truncate text-slate-700"><MapPin className="size-3.5 shrink-0 text-slate-400" />{u.home_area}</span> : <span className="text-slate-300">—</span>}
                            <div className={clsx('mt-0.5 flex items-center gap-1 text-[11px]', u.onboarded_at ? 'text-green-700' : 'text-slate-400')}>
                              {u.onboarded_at ? <CircleCheck className="size-3" /> : <CircleDashed className="size-3" />}
                              {t(u.onboarded_at ? 'admin.onboarded' : 'admin.notOnboarded')}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500">{u.last_sign_in_at ? ago(u.last_sign_in_at) : t('admin.never')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-slate-100 md:hidden">
                {rows.map((u) => {
                  const m = ROLE_META[u.role]
                  return (
                    <li key={u.id} className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.display_name} color={m.color} soft={m.soft} icon={m.icon} size={40} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 font-semibold text-slate-800"><span className="truncate">{name(u)}</span>{badges(u)}</div>
                          <div dir="ltr" className="font-latin truncate text-start text-xs text-slate-500">{contact(u)}</div>
                        </div>
                        {roleSelect(u)}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 ps-[52px]">
                        <TrustSlider u={u} onSaved={(v) => patch(u.id, { trust_score: v })} />
                        <span className="text-xs text-slate-500">{t('admin.nReports', { n: u.report_count })} · {u.last_sign_in_at ? ago(u.last_sign_in_at) : t('admin.never')}</span>
                      </div>
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
