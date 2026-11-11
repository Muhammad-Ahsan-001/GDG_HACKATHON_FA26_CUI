import clsx from 'clsx'
import { ArrowRight, Camera, LogIn, MapPin, Mic, Sparkles, Users, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ORG_TYPE_META } from '../components/auth/meta'
import { ErrorBanner } from '../components/auth/parts'
import { AppHeader } from '../components/layout/AppHeader'
import { Button } from '../components/ui'
import { homeFor, useAuth } from '../hooks/useAuth'
import { useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import { NGO_ORG_TYPES, RESPONDER_ORG_TYPES } from '../lib/types'

function Step({ n, icons, bg, title, body }: { n: number; icons: LucideIcon[]; bg: string; title: string; body: string }) {
  const { t } = useI18n()
  const First = icons[0]
  return (
    <li className="flex min-w-0 flex-1 flex-col items-center text-center" aria-label={`${t('auth.stepLabel', { n })}: ${title}`}>
      <span className={clsx('relative inline-flex size-20 items-center justify-center rounded-3xl text-white shadow-lg', bg)}>
        {icons.length === 1 ? <First className="size-10" /> : (
          <span className="flex items-center gap-0.5">
            {icons.map((I, i) => <I key={i} className="size-8" />)}
          </span>
        )}
        <span className="font-latin absolute -top-2 -end-2 inline-flex size-7 items-center justify-center rounded-full bg-white text-sm font-black text-ink shadow">{n}</span>
      </span>
      <span className="mt-2 text-base font-bold leading-tight">{title}</span>
      <span className="mt-0.5 text-xs leading-snug text-slate-600">{body}</span>
    </li>
  )
}

function StepArrow() {
  return <ArrowRight aria-hidden className="mt-7 size-5 shrink-0 text-slate-300 rtl:-scale-x-100" />
}

// GLOBE_HOOK (Phase 3): the animated globe mounts into the empty #globe-hero region below. Keep it lazy-loaded.
export default function Landing() {
  const { t } = useI18n()
  const { session, role, loading, signInAnonymously } = useAuth()
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [liveCount, setLiveCount] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const { count, error: e } = await supabase.from('map_pins').select('id', { count: 'exact', head: true })
      if (alive && !e && typeof count === 'number' && count > 0) setLiveCount(count)
    })()
    return () => { alive = false }
  }, [])

  async function start() {
    setError(null)
    if (session) { nav(homeFor(role)); return }
    setBusy(true)
    try {
      await signInAnonymously()
      nav('/map')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const orgTypes = [...RESPONDER_ORG_TYPES, ...NGO_ORG_TYPES]

  return (
    <div className="min-h-full bg-linear-to-b from-brand-50 via-white to-white">
      <AppHeader />
      <main className="mx-auto flex max-w-xl flex-col px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        {/* GLOBE_HOOK — Phase 3 animated globe renders here */}
        <div id="globe-hero" aria-hidden="true" />

        <section className="pt-6 text-center">
          <div className="relative mx-auto inline-block">
            <span aria-hidden className="absolute -inset-8 rounded-full bg-[radial-gradient(circle,var(--color-brand-100)_0%,transparent_70%)]" />
            <h1 className="relative">
              <span lang="ur" dir="rtl" className="font-urdu block text-7xl font-bold leading-[1.9] text-brand-700">آواز</span>
              <span lang="en" dir="ltr" className="font-latin -mt-3 block text-3xl font-black tracking-tight text-ink">Awaaz</span>
            </h1>
          </div>
          <p className="mt-3 text-xl font-bold text-ink">{t('common.tagline')}</p>
          <p className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-brand-700">
            <MapPin className="size-4" /> {t('auth.cityLine')}
          </p>
          <p className="mx-auto mt-3 max-w-md text-base text-slate-600">{t('auth.heroBody')}</p>
        </section>

        <section className="mt-7" aria-label={t('auth.howItWorks')}>
          <ol className="flex items-start gap-1.5">
            <Step n={1} icons={[Mic, Camera]} bg="bg-brand-700" title={t('auth.step1Title')} body={t('auth.step1Body')} />
            <StepArrow />
            <Step n={2} icons={[Sparkles]} bg="bg-violet-600" title={t('auth.step2Title')} body={t('auth.step2Body')} />
            <StepArrow />
            <Step n={3} icons={[ORG_TYPE_META.rescue_1122.icon]} bg="bg-green-600" title={t('auth.step3Title')} body={t('auth.step3Body')} />
          </ol>
        </section>

        <section className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={start}
            disabled={busy || loading}
            className="flex min-h-20 w-full items-center justify-center gap-3 rounded-3xl bg-brand-700 px-6 text-2xl font-black text-white shadow-xl shadow-brand-700/30 transition hover:bg-brand-900 active:scale-[0.98] disabled:opacity-70"
          >
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-white/15">
              {busy ? <span className="size-7 animate-spin rounded-full border-4 border-white/40 border-t-white" /> : <Mic className="size-8" />}
            </span>
            {t('auth.startReporting')}
          </button>
          <p className="text-sm text-slate-600">{t('auth.startHint')}</p>
          <ErrorBanner error={error} onDismiss={() => setError(null)} className="w-full" />
          {liveCount !== null && (
            <p className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm">
              <span className="relative inline-flex size-2.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-red-500/60" />
                <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
              </span>
              {t('auth.liveCount', { n: liveCount })}
            </p>
          )}
          <Button variant="secondary" size="lg" icon={LogIn} onClick={() => nav('/login')} className="w-full">
            {t('auth.signInOrgs')}
          </Button>
        </section>

        <section className="mt-10 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Users className="size-5 text-brand-700" />
            <h2 className="text-lg font-bold">{t('auth.forOrgsTitle')}</h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">{t('auth.forOrgsBody')}</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {orgTypes.map((ot) => {
              const m = ORG_TYPE_META[ot]
              const Icon = m.icon
              return (
                <li key={ot} className="inline-flex items-center gap-1.5 rounded-full py-1 pe-3 ps-1 text-sm font-semibold" style={{ background: m.soft, color: m.color }}>
                  <span className="inline-flex size-7 items-center justify-center rounded-full text-white" style={{ background: m.color }}>
                    <Icon className="size-4" />
                  </span>
                  {t(`auth.orgType_${ot}`)}
                </li>
              )
            })}
          </ul>
          <Button variant="primary" size="md" icon={ArrowRight} onClick={() => nav('/login?tab=signup&role=responder')} className="mt-4 w-full [&>svg]:rtl:-scale-x-100">
            {t('auth.registerOrg')}
          </Button>
        </section>
      </main>
    </div>
  )
}
