import clsx from 'clsx'
import { BadgeCheck, Building2, Check, Hourglass, LayoutDashboard, ListChecks, Map as MapIcon, MapPinned, Phone, Plus, Send } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ORG_TYPE_META, orgTypesFor } from '../components/auth/meta'
import { ErrorBanner, SectionTitle, TextField } from '../components/auth/parts'
import { ServiceAreaPicker, type LatLng } from '../components/auth/ServiceAreaPicker'
import { AppHeader } from '../components/layout/AppHeader'
import { Button, CategoryIcon, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { api } from '../lib/api'
import { CATEGORY_META } from '../lib/categories'
import { useI18n } from '../lib/i18n'
import { CATEGORIES, type Category, type Organization, type OrgType } from '../lib/types'

const isApproved = (o: Organization) => o.approved !== false

function OrgCard({ o }: { o: Organization }) {
  const { t } = useI18n()
  const m = ORG_TYPE_META[o.org_type]
  const Icon = m?.icon ?? Building2
  const ok = isApproved(o)
  return (
    <li className="rounded-3xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: m?.color ?? '#475569' }}>
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{o.name}</div>
          <div className="text-sm text-slate-600">
            {t(`auth.orgType_${o.org_type}`)}
            {o.radius_m ? <> · {t('auth.radiusKm', { n: Math.round(o.radius_m / 100) / 10 })}</> : null}
          </div>
        </div>
        <span className={clsx(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-sm font-bold',
          ok ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800',
        )}>
          {ok ? <BadgeCheck className="size-4" /> : <Hourglass className="size-4" />}
          {ok ? t('auth.approved') : t('auth.pending')}
        </span>
      </div>
      {o.categories?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {o.categories.map((c) => <CategoryIcon key={c} category={c} size={28} />)}
        </div>
      )}
    </li>
  )
}

export default function OrgRegister() {
  const { t, lang } = useI18n()
  const { role, orgs, refreshProfile } = useAuth()
  const nav = useNavigate()
  const types = orgTypesFor(role)

  // null = automatic: show the list when the user already has organisations, otherwise the form
  const [mode, setMode] = useState<'form' | 'list' | null>(null)
  const view = mode ?? (orgs.length ? 'list' : 'form')

  const [name, setName] = useState('')
  const [orgType, setOrgType] = useState<OrgType | null>(types.length === 1 ? types[0] : null)
  const [cats, setCats] = useState<Category[]>(types.length === 1 ? ORG_TYPE_META[types[0]].defaultCategories : [])
  const [center, setCenter] = useState<LatLng | null>(null)
  const [radiusKm, setRadiusKm] = useState(5)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const anyPending = orgs.some((o) => !isApproved(o))

  // while waiting, poll so the approval shows up without a reload (organizations are not in the realtime publication)
  useEffect(() => {
    if (view !== 'list' || !anyPending) return
    const id = setInterval(() => { void refreshProfile() }, 15000)
    return () => clearInterval(id)
  }, [view, anyPending, refreshProfile])

  function chooseType(ot: OrgType) {
    setOrgType(ot)
    setCats(ORG_TYPE_META[ot].defaultCategories)
    setError(null)
  }

  function toggleCat(c: Category) {
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const missing = name.trim().length < 2 ? 'auth.needOrgName'
      : !orgType ? 'auth.needOrgType'
      : cats.length === 0 ? 'auth.needCategory'
      : !center ? 'auth.needCenter'
      : null
    if (missing || !orgType || !center) { setError(missing); return }
    setBusy(true)
    try {
      await api.registerOrganization({
        name: name.trim(), org_type: orgType, categories: cats, lat: center.lat, lng: center.lng,
        radius_m: Math.round(radiusKm * 1000), phone: phone.trim() || undefined,
      })
      await refreshProfile()
      setName('')
      setPhone('')
      setMode('list')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!role) {
    return (
      <div className="min-h-full bg-slate-50">
        <AppHeader />
        <div className="flex justify-center py-16 text-brand-700"><Spinner className="size-10" /></div>
      </div>
    )
  }

  if (view === 'list') {
    return (
      <div className="min-h-full bg-slate-50">
        <AppHeader />
        <main className="mx-auto max-w-xl space-y-4 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
          <section className={clsx('flex flex-col items-center rounded-3xl p-5 text-center', anyPending ? 'bg-amber-50 ring-1 ring-amber-200' : 'bg-green-50 ring-1 ring-green-200')}>
            <span className={clsx('inline-flex size-20 items-center justify-center rounded-full text-white', anyPending ? 'bg-amber-500' : 'bg-green-600')}>
              {anyPending ? <Hourglass className="size-10" /> : <BadgeCheck className="size-10" />}
            </span>
            <h1 className="mt-3 text-2xl font-black">{anyPending ? t('auth.waitingTitle') : t('auth.approved')}</h1>
            {anyPending && <p className="mt-1 text-slate-700">{t('auth.waitingBody')}</p>}
          </section>

          <section>
            <SectionTitle icon={ListChecks}>{t('auth.myOrgs')}</SectionTitle>
            <ul className="space-y-2">{orgs.map((o) => <OrgCard key={o.id} o={o} />)}</ul>
          </section>

          <div className="grid gap-2">
            <Button size="lg" icon={LayoutDashboard} onClick={() => nav('/dashboard')}>{t('auth.goDashboard')}</Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" icon={Plus} onClick={() => { setMode('form'); window.scrollTo({ top: 0 }) }}>{t('auth.registerAnother')}</Button>
              <Button variant="secondary" icon={MapIcon} onClick={() => nav('/map')}>{t('auth.openMap')}</Button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-full bg-slate-50">
      <AppHeader />
      <main className="mx-auto max-w-xl px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <h1 className="text-2xl font-black">{t('auth.orgTitle')}</h1>
        <p className="mt-1 text-slate-600">{t('auth.orgSubtitle')}</p>

        <form onSubmit={submit} className="mt-5 space-y-6" noValidate>
          <TextField id="org-name" icon={Building2} label={t('auth.orgName')} value={name}
            onChange={(e) => setName(e.target.value)} placeholder={t('auth.orgNamePh')} autoComplete="organization" />

          {/* org type cards */}
          <section>
            <SectionTitle icon={Building2}>{t('auth.orgTypeTitle')}</SectionTitle>
            <div className="grid grid-cols-2 gap-2">
              {types.map((ot) => {
                const m = ORG_TYPE_META[ot]
                const Icon = m.icon
                const sel = orgType === ot
                return (
                  <button key={ot} type="button" onClick={() => chooseType(ot)} aria-pressed={sel}
                    className={clsx(
                      'relative flex min-h-28 flex-col items-center justify-center gap-2 rounded-3xl border-2 p-3 text-center font-bold transition active:scale-[0.97]',
                      sel ? 'shadow-md' : 'border-slate-200 bg-white',
                    )}
                    style={sel ? { borderColor: m.color, background: m.soft } : undefined}>
                    <span className="inline-flex size-14 items-center justify-center rounded-2xl text-white" style={{ background: m.color }}>
                      <Icon className="size-8" />
                    </span>
                    {t(`auth.orgType_${ot}`)}
                    {sel && (
                      <span className="absolute end-2 top-2 inline-flex size-7 items-center justify-center rounded-full text-white" style={{ background: m.color }}>
                        <Check className="size-4" />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>

          {/* categories multi-select */}
          <section>
            <SectionTitle icon={ListChecks}>{t('auth.categoriesTitle')}</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => {
                const m = CATEGORY_META[c]
                const Icon = m.icon
                const sel = cats.includes(c)
                return (
                  <button key={c} type="button" onClick={() => toggleCat(c)} aria-pressed={sel}
                    className={clsx('inline-flex min-h-12 items-center gap-2 rounded-full border-2 py-1 pe-4 ps-1 font-semibold transition active:scale-95',
                      sel ? 'text-white' : 'bg-white')}
                    style={sel ? { background: m.color, borderColor: m.color } : { borderColor: m.soft, color: m.color }}>
                    <span className="inline-flex size-9 items-center justify-center rounded-full"
                      style={sel ? { background: 'rgba(255,255,255,0.2)' } : { background: m.soft }}>
                      {sel ? <Check className="size-5" /> : <Icon className="size-5" />}
                    </span>
                    {lang === 'ur' ? m.ur : m.en}
                  </button>
                )
              })}
            </div>
          </section>

          {/* service area */}
          <section>
            <SectionTitle icon={MapPinned}>{t('auth.areaTitle')}</SectionTitle>
            <ServiceAreaPicker center={center} onCenter={setCenter} radiusKm={radiusKm} onRadiusKm={setRadiusKm} />
          </section>

          <TextField id="org-phone" icon={Phone} label={t('auth.phone')} type="tel" inputMode="tel" autoComplete="tel"
            value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('auth.phonePh')} ltr />

          <ErrorBanner error={error} onDismiss={() => setError(null)} />

          <div className="grid gap-2">
            <Button type="submit" size="lg" icon={Send} loading={busy} className="w-full [&>svg]:rtl:-scale-x-100">{t('auth.submitOrg')}</Button>
            {orgs.length > 0 && (
              <Button type="button" variant="ghost" icon={ListChecks} onClick={() => setMode('list')}>{t('auth.myOrgs')}</Button>
            )}
          </div>
        </form>
      </main>
    </div>
  )
}
