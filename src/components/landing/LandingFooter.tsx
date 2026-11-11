import { ArrowRight, Award, LogIn, Mic } from 'lucide-react'
import { useI18n } from '../../lib/i18n'
import { LangToggle, Logo } from './Brand'
import { Reveal } from './shared'

export function LandingFooter({ onStart, startLabel, onSignIn, onSos }: {
  onStart: () => void; startLabel: string; onSignIn: () => void; onSos: () => void
}) {
  const { t } = useI18n()
  return (
    <footer className="lp-sky relative overflow-hidden">
      <div aria-hidden className="lp-dots pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-6xl px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-16 lg:px-8">
        <Reveal className="text-center">
          <h2 className="text-3xl font-black tracking-tight text-slate-800 sm:text-4xl">{t('landing.ctaTitle')}</h2>
          <p className="mx-auto mt-3 max-w-lg text-base text-slate-600 sm:text-lg">{t('landing.ctaBody')}</p>
          <button type="button" onClick={onStart}
            className="lp-cta-shine mx-auto mt-7 flex min-h-16 w-full max-w-md items-center justify-center gap-3 rounded-full bg-brand-700 py-2 pe-5 ps-2 text-xl font-black text-white shadow-[0_22px_48px_-14px_rgba(13,148,136,.65)] ring-1 ring-white/40 transition hover:brightness-105 active:scale-[0.98]">
            <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-linear-to-b from-amber-400 to-amber-500 shadow-md shadow-amber-600/40 ring-2 ring-white/70">
              <Mic className="size-6" />
            </span>
            {startLabel}
            <ArrowRight className="size-6 rtl:-scale-x-100" />
          </button>
        </Reveal>

        <div className="mt-16 flex flex-col items-center gap-5 border-t border-slate-200 pt-8 md:flex-row md:justify-between">
          <div className="flex flex-col items-center gap-1 md:items-start">
            <Logo />
            <p className="text-sm text-slate-600">{t('landing.footerMade')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <LangToggle />
            <button type="button" onClick={onSignIn}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/80 px-4 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-white hover:text-brand-700">
              <LogIn className="size-4 rtl:-scale-x-100" />
              {t('landing.signIn')}
            </button>
            <button type="button" onClick={onSos}
              className="font-latin inline-flex min-h-11 items-center rounded-full bg-white/80 px-4 text-sm font-bold text-violet-700 shadow-sm ring-1 ring-violet-200 transition hover:bg-violet-50">
              {t('landing.footerSos')}
            </button>
          </div>
        </div>
        <p className="mt-8 flex justify-center">
          <span className="font-latin inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-xs font-bold tracking-wide text-slate-700 shadow-sm ring-1 ring-slate-200">
            <Award className="size-4 text-amber-500" />
            {t('landing.footerCredit')}
          </span>
        </p>
      </div>
    </footer>
  )
}
