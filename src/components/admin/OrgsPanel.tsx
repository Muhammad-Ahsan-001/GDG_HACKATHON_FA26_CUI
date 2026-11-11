import clsx from 'clsx'
import { BadgeCheck, Building2, Check, Hourglass, MapPin, Phone, Undo2, User, X } from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { adminApi, type AdminOrg } from '../../lib/adminApi'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { ORG_TYPE_META } from '../auth/meta'
import { Spinner, useTimeAgo } from '../ui'
import { useAdmin, useAsync } from './context'
import { Card, Empty, ErrorState, PanelHeader, Skeleton, SkeletonRows } from './parts'

const OrgMap = lazy(() => import('./OrgMap'))
const HIDDEN_KEY = 'awaaz.admin.rejected'

function readHidden(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(HIDDEN_KEY) || '[]') as string[]) } catch { return new Set() }
}
function writeHidden(s: Set<string>) {
  try { sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...s])) } catch { /* storage unavailable */ }
}

type Owners = Record<string, { id: string; display_name: string | null; phone: string | null }>

function OrgRow({ o, owner, selected, onSelect, busy, actions }: {
  o: AdminOrg; owner?: Owners[string]; selected: boolean; onSelect: () => void; busy: boolean
  actions: { label: string; icon: typeof Check; tone: 'ok' | 'bad' | 'muted'; run: () => void }[]
}) {
  const { t, lang } = useI18n()
  const ago = useTimeAgo()
  const m = ORG_TYPE_META[o.org_type]
  const Icon = m?.icon ?? Building2
  const phone = o.phone || owner?.phone
  const tone = { ok: 'bg-green-600 text-white hover:bg-green-700', bad: 'bg-white text-red-700 ring-1 ring-red-200 hover:bg-red-50', muted: 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50' }
  return (
    <li>
      <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}
        className={clsx('rounded-2xl p-3 transition', selected ? 'bg-brand-50/70 ring-2 ring-brand-500' : 'bg-white ring-1 ring-slate-200 hover:ring-slate-300')}>
        <div className="flex items-start gap-3">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: m?.color ?? '#475569' }}><Icon className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="font-bold leading-snug text-slate-900">{o.name}</div>
            <div className="text-xs text-slate-500">
              {t(`auth.orgType_${o.org_type}`)}
              {o.radius_m ? <> · {t('admin.radiusKm', { n: Math.round(o.radius_m / 100) / 10 })}</> : null}
              {o.created_at ? <> · {ago(o.created_at)}</> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1"><User className="size-3.5" />{t('admin.owner', { name: owner?.display_name || t('admin.unknownOwner') })}</span>
              {phone && <a href={`tel:${phone}`} dir="ltr" onClick={(e) => e.stopPropagation()} className="font-latin inline-flex items-center gap-1 text-brand-700 underline"><Phone className="size-3.5" />{phone}</a>}
            </div>
          </div>
        </div>
        {o.categories?.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="me-1 text-[11px] font-semibold text-slate-400">{t('admin.handles')}</span>
            {o.categories.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: CATEGORY_META[c]?.soft, color: CATEGORY_META[c]?.color }}>
                {(() => { const I = CATEGORY_META[c]?.icon; return I ? <I className="size-3" /> : null })()}
                {lang === 'ur' ? CATEGORY_META[c]?.ur : CATEGORY_META[c]?.en}
              </span>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className={clsx('mt-3 grid gap-2', actions.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
            {actions.map((a) => (
              <button key={a.label} type="button" disabled={busy} onClick={(e) => { e.stopPropagation(); a.run() }}
                className={clsx('inline-flex min-h-10 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition disabled:opacity-50', tone[a.tone])}>
                {busy ? <Spinner className="size-4" /> : <a.icon className="size-4" />} {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

export default function OrgsPanel() {
  const { t } = useI18n()
  const { version, toast, refresh } = useAdmin()
  const [hidden, setHidden] = useState<Set<string>>(readHidden)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const { data, error, loading, reload } = useAsync(async () => {
    const orgs = await adminApi.listOrgs()
    const owners = await adminApi.owners([...new Set(orgs.map((o) => o.owner_id).filter(Boolean))]).catch(() => ({} as Owners))
    return { orgs, owners }
  }, [version])

  const orgs = data?.orgs ?? []
  const pending = useMemo(() => orgs.filter((o) => !o.approved && !hidden.has(o.id)), [orgs, hidden])
  const approved = useMemo(() => orgs.filter((o) => o.approved), [orgs])
  const shown = useMemo(() => [...pending, ...approved], [pending, approved])

  async function act(o: AdminOrg, kind: 'approve' | 'reject' | 'revoke') {
    setBusyId(o.id)
    try {
      await api.approveOrganization(o.id, kind === 'approve')
      setHidden((prev) => {
        const next = new Set(prev)
        if (kind === 'reject') next.add(o.id)
        else next.delete(o.id)
        writeHidden(next)
        return next
      })
      toast(t(kind === 'approve' ? 'admin.org_approvedToast' : kind === 'reject' ? 'admin.org_rejectedToast' : 'admin.org_revokedToast', { name: o.name }))
      refresh()
      reload()
    } catch (e) {
      toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error')
    } finally { setBusyId(null) }
  }

  return (
    <div>
      <PanelHeader title={t('admin.org_title')} icon={Building2} sub={data ? t('admin.org_sub', { a: approved.length, p: pending.length }) : undefined} />
      {error && !data ? <Card><ErrorState error={error} onRetry={reload} /></Card> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="order-2 space-y-4 lg:order-1">
            <Card title={t('admin.org_pending')} icon={Hourglass}
              action={pending.length ? <span className="font-latin rounded-full bg-amber-400 px-2.5 py-0.5 text-sm font-bold text-amber-950">{pending.length}</span> : null}>
              {loading ? <SkeletonRows rows={2} /> : pending.length === 0 ? <Empty icon={BadgeCheck} title={t('admin.org_noPending')} /> : (
                <ul className="space-y-2">
                  {pending.map((o) => (
                    <OrgRow key={o.id} o={o} owner={data?.owners[o.owner_id]} selected={selected === o.id} onSelect={() => setSelected(o.id)} busy={busyId === o.id}
                      actions={[
                        { label: t('admin.approve'), icon: Check, tone: 'ok', run: () => { void act(o, 'approve') } },
                        { label: t('admin.reject'), icon: X, tone: 'bad', run: () => { void act(o, 'reject') } },
                      ]} />
                  ))}
                </ul>
              )}
            </Card>
            <Card title={t('admin.org_approved')} icon={BadgeCheck}
              action={<span className="font-latin rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-bold text-slate-600">{approved.length}</span>}>
              {loading ? <SkeletonRows rows={4} /> : approved.length === 0 ? <Empty icon={Building2} title={t('admin.org_noApproved')} /> : (
                <ul className="space-y-2">
                  {approved.map((o) => (
                    <OrgRow key={o.id} o={o} owner={data?.owners[o.owner_id]} selected={selected === o.id} onSelect={() => setSelected(o.id)} busy={busyId === o.id}
                      actions={[{ label: t('admin.revoke'), icon: Undo2, tone: 'muted', run: () => { void act(o, 'revoke') } }]} />
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div className="order-1 lg:order-2">
            <div className="lg:sticky lg:top-20">
              <Card title={t('admin.serviceArea')} icon={MapPin} sub={t('admin.org_mapHint')} bodyClass="p-2 pt-1">
                <div className="relative h-[280px] overflow-hidden rounded-xl bg-slate-100 sm:h-[360px] lg:h-[calc(100dvh-14rem)]">
                  {loading ? <Skeleton className="absolute inset-0 rounded-none" /> : (
                    <Suspense fallback={<Skeleton className="absolute inset-0 rounded-none" />}>
                      <OrgMap orgs={shown} selected={selected} onSelect={setSelected} />
                    </Suspense>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
