import clsx from 'clsx'
import {
  BadgeCheck, Building2, ChartColumn, Check, ExternalLink, Hourglass, LayoutDashboard, Map as MapIcon, MapPin, Phone, RefreshCw,
  Undo2, User, X, type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ORG_TYPE_META } from '../components/auth/meta'
import { ErrorBanner, SectionTitle, Toast } from '../components/auth/parts'
import { AppHeader } from '../components/layout/AppHeader'
import { Button, CategoryIcon, EmptyState, Spinner, useTimeAgo } from '../components/ui'
import { api } from '../lib/api'
import { CATEGORY_META } from '../lib/categories'
import { useI18n } from '../lib/i18n'
import { STATUS_META } from '../lib/status'
import { supabase } from '../lib/supabase'
import { CATEGORIES, type Category, type Organization, type ReportStatus } from '../lib/types'

/** org_directory row as seen by an admin (approved + unapproved). */
type OrgRow = Organization & { owner_id: string; approved: boolean; phone?: string | null; created_at?: string | null }
interface Owner { id: string; display_name: string | null; phone: string | null }
interface PinLite { status: ReportStatus; category: Category }

const STATUSES: ReportStatus[] = ['unconfirmed', 'verified', 'disputed', 'in_progress', 'resolved']
const HIDDEN_KEY = 'awaaz.admin.rejected'

function readHidden(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(HIDDEN_KEY) || '[]') as string[]) } catch { return new Set() }
}
function writeHidden(s: Set<string>) {
  try { sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...s])) } catch { /* storage unavailable */ }
}

function OrgItem({ o, owner, busy, actions }: {
  o: OrgRow; owner?: Owner; busy: boolean
  actions: { label: string; icon: LucideIcon; variant: 'success' | 'danger' | 'secondary'; onClick: () => void }[]
}) {
  const { t, lang } = useI18n()
  const ago = useTimeAgo()
  const m = ORG_TYPE_META[o.org_type]
  const Icon = m?.icon ?? Building2
  const phone = o.phone || owner?.phone
  return (
    <li className="rounded-3xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: m?.color ?? '#475569' }}>
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-bold leading-snug">{o.name}</div>
          <div className="text-sm text-slate-600">
            {t(`auth.orgType_${o.org_type}`)}
            {o.radius_m ? <> · {t('auth.radiusKm', { n: Math.round(o.radius_m / 100) / 10 })}</> : null}
            {o.created_at ? <> · {ago(o.created_at)}</> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1"><User className="size-3.5" />
              {t('auth.owner', { name: owner?.display_name || t('auth.unknownOwner') })}</span>
            {phone && <a href={`tel:${phone}`} dir="ltr" className="font-latin inline-flex items-center gap-1 text-brand-700 underline"><Phone className="size-3.5" />{phone}</a>}
            {Number.isFinite(o.lat) && Number.isFinite(o.lng) && (
              <a href={`https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}`} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-brand-700 underline">
                <MapPin className="size-3.5" /> {t('auth.viewOnMap')} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
      </div>
      {o.categories?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {o.categories.map((c) => (
            <span key={c} className="inline-flex items-center gap-1 rounded-full py-0.5 pe-2 ps-0.5 text-xs font-semibold"
              style={{ background: CATEGORY_META[c]?.soft, color: CATEGORY_META[c]?.color }}>
              <CategoryIcon category={c} size={22} /> {lang === 'ur' ? CATEGORY_META[c]?.ur : CATEGORY_META[c]?.en}
            </span>
          ))}
        </div>
      )}
      <div className={clsx('mt-3 grid gap-2', actions.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
        {actions.map((a) => (
          <Button key={a.label} variant={a.variant} icon={a.icon} loading={busy} onClick={a.onClick}>{a.label}</Button>
        ))}
      </div>
    </li>
  )
}

export default function Admin() {
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null)
  const [owners, setOwners] = useState<Record<string, Owner>>({})
  const [pins, setPins] = useState<PinLite[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(readHidden)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refreshing, setRefreshing] = useState(false)
  const clearToast = useCallback(() => setToast(null), [])

  const loadPins = useCallback(async () => {
    const { data, error: e } = await supabase.from('map_pins').select('status, category')
    if (e) { setError(e); return }
    setPins((data as PinLite[] | null) ?? [])
  }, [])

  const loadOrgs = useCallback(async () => {
    const { data, error: e } = await supabase.from('org_directory').select('*').order('name')
    if (e) { setError(e); return }
    const rows = (data as OrgRow[] | null) ?? []
    setOrgs(rows)
    const ids = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))]
    if (ids.length) {
      const { data: p } = await supabase.from('profiles').select('id, display_name, phone').in('id', ids)
      setOwners(Object.fromEntries(((p as Owner[] | null) ?? []).map((x) => [x.id, x])))
    }
  }, [])

  const loadAll = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([loadOrgs(), loadPins()])
    setRefreshing(false)
  }, [loadOrgs, loadPins])

  useEffect(() => { void loadAll() }, [loadAll])

  // live stats: refetch pin counts (debounced) whenever a cluster changes
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const ch = supabase
      .channel(`admin-clusters-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clusters' }, () => {
        if (debounce.current) clearTimeout(debounce.current)
        debounce.current = setTimeout(() => { void loadPins() }, 1500)
      })
      .subscribe()
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
      void supabase.removeChannel(ch)
    }
  }, [loadPins])

  // refresh organisations when the admin comes back to the tab
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') void loadOrgs() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [loadOrgs])

  async function act(o: OrgRow, kind: 'approve' | 'reject' | 'revoke') {
    setError(null)
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
      setToast(t(kind === 'approve' ? 'auth.approvedToast' : kind === 'reject' ? 'auth.rejectedToast' : 'auth.revokedToast', { name: o.name }))
      await loadOrgs()
    } catch (e) {
      setError(e)
    } finally {
      setBusyId(null)
    }
  }

  const pending = useMemo(() => (orgs ?? []).filter((o) => o.approved === false && !hidden.has(o.id)), [orgs, hidden])
  const approved = useMemo(() => (orgs ?? []).filter((o) => o.approved !== false), [orgs])

  const byStatus = useMemo(() => {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ReportStatus, number>
    for (const p of pins ?? []) if (p.status in out) out[p.status]++
    return out
  }, [pins])
  const byCategory = useMemo(() => {
    const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
    for (const p of pins ?? []) if (p.category in out) out[p.category]++
    return out
  }, [pins])

  return (
    <div className="min-h-full bg-slate-50">
      <AppHeader right={
        <button type="button" onClick={() => { void loadAll() }} aria-label={t('auth.refresh')} title={t('auth.refresh')}
          className="inline-flex size-11 items-center justify-center rounded-full bg-white/90 shadow-sm hover:bg-white">
          <RefreshCw className={clsx('size-5', refreshing && 'animate-spin')} />
        </button>
      } />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="flex-1 text-2xl font-black">{t('auth.adminTitle')}</h1>
          <Button variant="secondary" icon={MapIcon} onClick={() => nav('/map')}>{t('common.map')}</Button>
          <Button icon={LayoutDashboard} onClick={() => nav('/dashboard')}>{t('auth.openDashboard')}</Button>
        </div>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {/* stats */}
        <section>
          <SectionTitle icon={ChartColumn}>{t('auth.statsTitle')}</SectionTitle>
          {pins === null ? (
            <div className="flex justify-center py-6 text-brand-700"><Spinner /></div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                <div className="flex flex-col items-center justify-center rounded-2xl bg-brand-700 p-3 text-white">
                  <MapPin className="size-6" />
                  <div className="font-latin text-2xl font-black">{pins.length}</div>
                  <div className="text-center text-xs font-semibold">{t('auth.totalPins')}</div>
                </div>
                {STATUSES.map((s) => {
                  const m = STATUS_META[s]
                  const Icon = m.icon
                  return (
                    <div key={s} className="flex flex-col items-center justify-center rounded-2xl p-3" style={{ background: m.soft, color: m.color }}
                      aria-label={`${lang === 'ur' ? m.ur : m.en}: ${byStatus[s]}`}>
                      <Icon className="size-6" />
                      <div className="font-latin text-2xl font-black">{byStatus[s]}</div>
                      <div className="text-center text-xs font-semibold">{lang === 'ur' ? m.ur : m.en}</div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 text-sm font-semibold text-slate-600">{t('auth.byCategory')}</div>
              <div className="mt-1 grid grid-cols-4 gap-2 sm:grid-cols-8">
                {CATEGORIES.map((c) => (
                  <div key={c} className="flex flex-col items-center gap-1 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-slate-200"
                    aria-label={`${lang === 'ur' ? CATEGORY_META[c].ur : CATEGORY_META[c].en}: ${byCategory[c]}`}>
                    <CategoryIcon category={c} size={36} />
                    <div className="font-latin text-lg font-black">{byCategory[c]}</div>
                    <div className="text-center text-[11px] font-semibold leading-tight text-slate-600">{lang === 'ur' ? CATEGORY_META[c].ur : CATEGORY_META[c].en}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        {/* pending organisations */}
        <section>
          <SectionTitle icon={Hourglass} right={pending.length ? <span className="font-latin rounded-full bg-amber-500 px-2.5 py-0.5 text-sm font-bold text-white">{pending.length}</span> : null}>
            {t('auth.pendingOrgs')}
          </SectionTitle>
          {orgs === null ? (
            <div className="flex justify-center py-6 text-brand-700"><Spinner /></div>
          ) : pending.length === 0 ? (
            <EmptyState icon={BadgeCheck} title={t('auth.noPending')} />
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {pending.map((o) => (
                <OrgItem key={o.id} o={o} owner={owners[o.owner_id]} busy={busyId === o.id} actions={[
                  { label: t('auth.approve'), icon: Check, variant: 'success', onClick: () => { void act(o, 'approve') } },
                  { label: t('auth.reject'), icon: X, variant: 'danger', onClick: () => { void act(o, 'reject') } },
                ]} />
              ))}
            </ul>
          )}
        </section>

        {/* approved organisations */}
        <section>
          <SectionTitle icon={BadgeCheck}>{t('auth.approvedOrgs')}</SectionTitle>
          {orgs === null ? null : approved.length === 0 ? (
            <EmptyState icon={Building2} title={t('auth.noApproved')} />
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {approved.map((o) => (
                <OrgItem key={o.id} o={o} owner={owners[o.owner_id]} busy={busyId === o.id} actions={[
                  { label: t('auth.revoke'), icon: Undo2, variant: 'secondary', onClick: () => { void act(o, 'revoke') } },
                ]} />
              ))}
            </ul>
          )}
        </section>
      </main>
      <Toast message={toast} onDone={clearToast} />
    </div>
  )
}
