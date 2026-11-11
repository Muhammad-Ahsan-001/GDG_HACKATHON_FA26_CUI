import clsx from 'clsx'
import { Camera, Keyboard, Mic, Sparkles, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import { ORG_TYPE_META } from '../auth/meta'
import { AiLabel } from '../ui'
import { Bi, Reveal, SectionHead } from './shared'

function Chip({ icon: Icon, label, color, soft }: { icon: LucideIcon; label: string; color: string; soft: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full py-0.5 pe-2.5 ps-1 text-xs font-bold shadow-sm ring-1 ring-black/5" style={{ background: soft, color }}>
      <span className="inline-flex size-5 items-center justify-center rounded-full text-white" style={{ background: color }}>
        <Icon className="size-3" />
      </span>
      {label}
    </span>
  )
}

function SpeakArt() {
  const { t } = useI18n()
  return (
    <div className="relative flex h-full items-center justify-center">
      <span className="absolute size-36 rounded-full bg-amber-200/50" />
      <span className="absolute size-28 rounded-full bg-amber-300/40" />
      <span className="relative inline-flex size-20 items-center justify-center rounded-full bg-linear-to-b from-amber-400 to-amber-500 text-white shadow-xl shadow-amber-500/40">
        <Mic className="size-10" />
      </span>
      <span className="lp-wave absolute start-[14%] top-1/2 flex h-10 -translate-y-1/2 items-center gap-1 text-amber-500" aria-hidden>
        <span className="h-4" /><span className="h-8" /><span className="h-10" /><span className="h-6" /><span className="h-3" />
      </span>
      <span className="absolute end-[10%] top-[18%]"><Chip icon={Camera} label={t('landing.step1Chip2')} color="#B45309" soft="#FEF3C7" /></span>
      <span className="absolute bottom-[14%] end-[16%]"><Chip icon={Keyboard} label={t('landing.step1Chip3')} color="#B45309" soft="#FEF3C7" /></span>
      <span className="absolute start-[12%] top-[14%]"><Chip icon={Mic} label={t('landing.step1Chip1')} color="#B45309" soft="#FEF3C7" /></span>
    </div>
  )
}

function VerifyArt() {
  const { t, pick } = useI18n()
  const water = CATEGORY_META.water
  const verified = STATUS_META.verified
  const WaterIcon = water.icon
  return (
    <div className="relative flex h-full items-center justify-center">
      <span className="absolute size-36 rounded-full bg-violet-200/50" />
      <Sparkles className="absolute end-[16%] top-[12%] size-7 text-violet-400" aria-hidden />
      <Sparkles className="absolute bottom-[16%] start-[14%] size-5 text-violet-300" aria-hidden />
      <div className="relative w-52 rounded-2xl bg-white p-3 shadow-xl shadow-violet-900/10 ring-1 ring-violet-100">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: water.color }}>
            <WaterIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="h-2.5 w-24 rounded-full bg-slate-200" />
            <div className="mt-1.5 h-2 w-16 rounded-full bg-slate-100" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Chip icon={verified.icon} label={pick(verified.en, verified.ur) || t('landing.step2Chip')} color={verified.color} soft={verified.soft} />
          <AiLabel />
        </div>
      </div>
    </div>
  )
}

function AlertArt() {
  const { pick } = useI18n()
  const resolved = STATUS_META.resolved
  const orgs = (['rescue_1122', 'fire', 'police', 'water'] as const).map((o) => ORG_TYPE_META[o])
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4">
      <span className="absolute size-36 rounded-full bg-emerald-200/50" />
      <div className="relative flex -space-x-2 rtl:space-x-reverse">
        {orgs.map((o, i) => {
          const Icon = o.icon
          return (
            <span key={i} className="inline-flex size-14 items-center justify-center rounded-2xl text-white shadow-lg ring-4 ring-white" style={{ background: o.color, transform: `rotate(${(i - 1.5) * 6}deg)` }}>
              <Icon className="size-7" />
            </span>
          )
        })}
      </div>
      <span className="relative"><Chip icon={resolved.icon} label={pick(resolved.en, resolved.ur)} color={resolved.color} soft={resolved.soft} /></span>
    </div>
  )
}

function StepCard({ n, art, tint, titleKey, bodyKey, delay }: {
  n: number; art: ReactNode; tint: string; titleKey: string; bodyKey: string; delay: number
}) {
  const { t } = useI18n()
  return (
    <Reveal as="li" delay={delay} className="relative">
      <div className="flex h-full flex-col overflow-hidden rounded-[1.75rem] bg-white shadow-[0_1px_2px_rgba(15,23,42,.06),0_18px_40px_-18px_rgba(15,23,42,.18)] ring-1 ring-slate-200/80">
        <div className={clsx('relative h-48 overflow-hidden', tint)} aria-hidden>{art}</div>
        <div className="flex flex-1 flex-col p-5">
          <span className="font-latin inline-flex w-fit items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-black text-brand-700 ring-1 ring-brand-100">{t('landing.step', { n })}</span>
          <Bi as="h3" k={titleKey} className="mt-3 text-xl font-black leading-tight text-slate-800" />
          <p className="mt-2 text-[0.95rem] leading-relaxed text-slate-600">{t(bodyKey)}</p>
        </div>
      </div>
    </Reveal>
  )
}

export function HowItWorks() {
  return (
    <section id="how" className="relative mx-auto max-w-6xl px-4 py-20 sm:py-24 lg:px-8">
      <SectionHead titleKey="landing.howTitle" subKey="landing.howSub" />
      <div className="relative mt-12">
      <span aria-hidden className="pointer-events-none absolute inset-x-[16%] top-24 hidden border-t-2 border-dashed border-slate-300 md:block" />
      <ol className="relative grid gap-5 md:grid-cols-3 md:gap-6">
        <StepCard n={1} delay={0} art={<SpeakArt />} tint="bg-linear-to-br from-amber-50 to-orange-100" titleKey="landing.step1Title" bodyKey="landing.step1Body" />
        <StepCard n={2} delay={0.12} art={<VerifyArt />} tint="bg-linear-to-br from-violet-50 to-indigo-100" titleKey="landing.step2Title" bodyKey="landing.step2Body" />
        <StepCard n={3} delay={0.24} art={<AlertArt />} tint="bg-linear-to-br from-emerald-50 to-teal-100" titleKey="landing.step3Title" bodyKey="landing.step3Body" />
      </ol>
      </div>
    </section>
  )
}
