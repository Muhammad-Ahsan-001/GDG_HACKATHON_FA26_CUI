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
    <div className="relative overflow-hidden rounded-3xl bg-white/[0.06] p-4 ring-1 ring-white/10 sm:p-5">
      <span className="inline-flex size-10 items-center justify-center rounded-2xl" style={{ background: `${accent}26`, color: accent }}>
        <Icon className="size-5" />
      </span>
      <div className="font-latin mt-3 h-12 text-[2.6rem] font-black leading-none tracking-tight text-white tabular-nums sm:h-14 sm:text-5xl">
        {loading ? <span className="inline-block h-10 w-16 animate-pulse rounded-xl bg-white/10" /> : n}
      </div>
      <div className="mt-1 text-sm font-semibold text-white/70">{label}</div>
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
    <section className="relative overflow-hidden bg-[#041325] py-20 text-white sm:py-24">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_80%_0%,rgba(20,184,166,.25),transparent_70%),radial-gradient(50%_50%_at_0%_100%,rgba(45,212,191,.10),transparent_70%)]" />
      <div className="relative mx-auto max-w-6xl px-4 lg:px-8">
        <SectionHead dark titleKey="landing.impactTitle" subKey="landing.impactSub"
          eyebrow={
            <span className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-bold ring-1 ring-white/15">
              <span className="lp-live-dot" />
              <span className="font-latin uppercase tracking-wider text-red-300">{t('landing.stageLive')}</span>
            </span>
          } />

        <div ref={ref} className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Stat icon={Megaphone} value={stats.reports} label={t('landing.statReports')} run={inView} loading={loading} accent="#fbbf24" />
          <Stat icon={CircleCheck} value={stats.verified} label={t('landing.statVerified')} run={inView} loading={loading} accent="#4ade80" />
          <Stat icon={CheckCheck} value={stats.resolved} label={t('landing.statResolved')} run={inView} loading={loading} accent="#34d399" />
          <Stat icon={Layers} value={stats.cats.length} label={t('landing.statCategories')} run={inView} loading={loading} accent="#5eead4" />
        </div>

        {failed ? (
          <p className="mt-6 text-center text-sm text-white/60">{t('landing.impactEmpty')}</p>
        ) : stats.cats.length > 0 && (
          <Reveal delay={0.15}>
            <ul className="mt-6 flex flex-wrap justify-center gap-2">
              {stats.cats.map(([c, n]) => {
                const meta = CATEGORY_META[c] ?? CATEGORY_META.other
                const Icon = meta.icon
                return (
                  <li key={c} className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] py-1 pe-3 ps-1 text-sm font-semibold text-white ring-1 ring-white/10">
                    <span className="inline-flex size-7 items-center justify-center rounded-full text-white" style={{ background: meta.color }}>
                      <Icon className="size-4" />
                    </span>
                    {pick(meta.en, meta.ur)}
                    <span className="text-white/60 tabular-nums">{t('landing.impactCat', { n })}</span>
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
