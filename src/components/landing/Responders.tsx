import { ArrowRight, BadgeCheck, Building2 } from 'lucide-react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { NGO_ORG_TYPES, RESPONDER_ORG_TYPES } from '../../lib/types'
import { ORG_TYPE_META } from '../auth/meta'
import { Reveal, SectionHead } from './shared'

const ORDER = [...RESPONDER_ORG_TYPES, ...NGO_ORG_TYPES]

export function Responders({ onRegister }: { onRegister: () => void }) {
  const { t, pick } = useI18n()
  return (
    <section className="relative bg-slate-50 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 lg:px-8">
        <SectionHead titleKey="landing.whoTitle" subKey="landing.whoSub" />
        <ul className="mt-12 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {ORDER.map((ot, i) => {
            const m = ORG_TYPE_META[ot]
            const Icon = m.icon
            return (
              <Reveal as="li" key={ot} delay={Math.min(i, 6) * 0.05} y={18}>
                <div className="group relative flex h-full flex-col rounded-3xl bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,.05)] ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-lg sm:p-5">
                  <span aria-hidden className="absolute inset-x-0 top-0 h-1 rounded-t-3xl" style={{ background: m.color }} />
                  <div className="flex items-start justify-between gap-2">
                    <span className="inline-flex size-14 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: m.color, boxShadow: `0 10px 24px -10px ${m.color}` }}>
                      <Icon className="size-7" />
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[0.7rem] font-bold text-slate-600">
                      <BadgeCheck className="size-3.5 text-brand-600" />
                      {t('landing.demoPartner')}
                    </span>
                  </div>
                  <h3 className="mt-3 text-lg font-black leading-tight text-slate-800">{t(`landing.org_${ot}`)}</h3>
                  <p className="mt-1 flex-1 text-sm leading-snug text-slate-600">{t(`landing.org_${ot}_body`)}</p>
                  <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t('landing.whoTitle')}>
                    {m.defaultCategories.map((c) => {
                      const cm = CATEGORY_META[c]
                      const CIcon = cm.icon
                      return (
                        <li key={c} className="inline-flex items-center gap-1 rounded-full py-0.5 pe-2 ps-0.5 text-xs font-semibold text-slate-700" style={{ background: cm.soft }}>
                          <span className="inline-flex size-5 items-center justify-center rounded-full text-white" style={{ background: cm.color }}>
                            <CIcon className="size-3" />
                          </span>
                          {pick(cm.en, cm.ur)}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </Reveal>
            )
          })}
          <Reveal as="li" delay={0.35} y={18}>
            <button type="button" onClick={onRegister}
              className="relative flex h-full min-h-44 w-full flex-col items-start justify-between overflow-hidden rounded-3xl bg-linear-to-br from-brand-600 via-brand-700 to-brand-700 p-5 text-start text-white shadow-[0_18px_40px_-18px_rgba(13,148,136,.7)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_48px_-18px_rgba(13,148,136,.8)] active:scale-[0.99]">
              <span aria-hidden className="pointer-events-none absolute -end-10 -top-10 size-40 rounded-full bg-[radial-gradient(circle,rgba(251,191,36,.35),transparent_65%)]" />
              <span className="relative inline-flex size-14 items-center justify-center rounded-2xl bg-white/20 ring-1 ring-white/30">
                <Building2 className="size-7" />
              </span>
              <span className="relative mt-4 flex w-full items-center justify-between gap-2 text-lg font-black leading-tight">
                {t('landing.registerOrg')}
                <ArrowRight className="size-5 shrink-0 rtl:-scale-x-100" />
              </span>
            </button>
          </Reveal>
        </ul>
        <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-slate-500">{t('landing.demoNote')}</p>
      </div>
    </section>
  )
}
