import { CheckCheck, CircleCheck, Layers, Megaphone, type LucideIcon } from 'lucide-react'
import { useInView } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import type { Category } from '../../lib/types'
import { prefersReducedMotion, Reveal, SectionHead, type LandingPin } from './shared'

function useCountUp(value: number, run: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!run) return
    if (prefersReducedMotion() || value === 0) { setN(value); return }
    let raf = 0
    let start = 0
    const tick = (now: number) => {
      start ||= now
      const p = Math.min(1, (now - start) / 1500)
      setN(Math.round(value * (1 - (1 - p) ** 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, run])
  return n
}

function Stat({ icon: Icon, value, label, run, loading, accent }: {
  icon: LucideIcon; value: number; label: string; run: boolean; loading: boolean; accent: string
}) {
  const n = useCountUp(value, run && !loading)
  return (
    <div className="relative overflow-hidden rounded-3xl bg-white/85 p-4 shadow-[0_1px_2px_rgba(15,23,42,.05),0_16px_36px_-18px_rgba(15,118,110,.28)] ring-1 ring-slate-200/80 backdrop-blur sm:p-5">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} />
      <span className="inline-flex size-10 items-center justify-center rounded-2xl" style={{ background: `${accent}1f`, color: accent }}>
        <Icon className="size-5" />
      </span>
      <div className="font-latin mt-3 h-12 text-[2.6rem] font-black leading-none tracking-tight text-slate-800 tabular-nums sm:h-14 sm:text-5xl">
        {loading ? <span className="inline-block h-10 w-16 animate-pulse rounded-xl bg-slate-200/80" /> : n}
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-600">{label}</div>
    </div>
  )
}

export function ImpactStrip({ pins, failed }: { pins: LandingPin[] | null; failed: boolean }) {
  const { t, pick } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.3 })
  const loading = pins === null

  const stats = useMemo(() => {
    const list = pins ?? []
    const open = list.filter((p) => p.status !== 'resolved')
    const byCat = new Map<Category, number>()
    for (const p of open) byCat.set(p.category, (byCat.get(p.category) ?? 0) + 1)
    return {
      reports: list.reduce((s, p) => s + (p.report_count || 0), 0),
      verified: list.filter((p) => p.status === 'verified' || p.status === 'in_progress' || p.status === 'resolved').length,
      resolved: list.filter((p) => p.status === 'resolved').length,
      cats: [...byCat.entries()].sort((a, b) => b[1] - a[1]),
    }
  }, [pins])

  return (
    <section className="relative overflow-hidden bg-linear-to-b from-white via-brand-50 to-slate-50 py-20 sm:py-24">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_55%_at_82%_35%,rgba(45,212,191,.20),transparent_70%),radial-gradient(45%_50%_at_12%_60%,rgba(251,191,36,.16),transparent_70%)]" />
      <div className="relative mx-auto max-w-6xl px-4 lg:px-8">
        <SectionHead titleKey="landing.impactTitle" subKey="landing.impactSub"
          eyebrow={
            <span className="mb-4 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-bold shadow-sm ring-1 ring-red-100">
              <span className="lp-live-dot" />
              <span className="font-latin uppercase tracking-wider text-red-600">{t('landing.stageLive')}</span>
            </span>
          } />

        <div ref={ref} className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Stat icon={Megaphone} value={stats.reports} label={t('landing.statReports')} run={inView} loading={loading} accent="#d97706" />
          <Stat icon={CircleCheck} value={stats.verified} label={t('landing.statVerified')} run={inView} loading={loading} accent="#16a34a" />
          <Stat icon={CheckCheck} value={stats.resolved} label={t('landing.statResolved')} run={inView} loading={loading} accent="#059669" />
          <Stat icon={Layers} value={stats.cats.length} label={t('landing.statCategories')} run={inView} loading={loading} accent="#0d9488" />
        </div>

        {failed ? (
          <p className="mt-6 text-center text-sm text-slate-600">{t('landing.impactEmpty')}</p>
        ) : stats.cats.length > 0 && (
          <Reveal delay={0.15}>
            <ul className="mt-6 flex flex-wrap justify-center gap-2">
              {stats.cats.map(([c, n]) => {
                const meta = CATEGORY_META[c] ?? CATEGORY_META.other
                const Icon = meta.icon
                return (
                  <li key={c} className="inline-flex items-center gap-2 rounded-full bg-white py-1 pe-3 ps-1 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">
                    <span className="inline-flex size-7 items-center justify-center rounded-full text-white" style={{ background: meta.color }}>
                      <Icon className="size-4" />
                    </span>
                    {pick(meta.en, meta.ur)}
                    <span className="text-slate-500 tabular-nums">{t('landing.impactCat', { n })}</span>
                  </li>
                )
              })}
            </ul>
          </Reveal>
        )}
      </div>
    </section>
  )
}
