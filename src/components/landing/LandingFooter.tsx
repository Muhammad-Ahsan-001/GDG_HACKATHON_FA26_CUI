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
      <div aria-hidden className="lp-stars pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-6xl px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-16 lg:px-8">
        <Reveal className="text-center">
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">{t('landing.ctaTitle')}</h2>
          <p className="mx-auto mt-3 max-w-lg text-base text-white/75 sm:text-lg">{t('landing.ctaBody')}</p>
          <button type="button" onClick={onStart}
            className="lp-cta-shine mx-auto mt-7 flex min-h-16 w-full max-w-md items-center justify-center gap-3 rounded-full bg-linear-to-b from-amber-300 to-amber-400 px-5 text-xl font-black text-[#2a1600] shadow-2xl shadow-amber-500/25 transition hover:brightness-105 active:scale-[0.98]">
            <Mic className="size-6" />
            {startLabel}
            <ArrowRight className="size-6 rtl:-scale-x-100" />
          </button>
        </Reveal>

        <div className="mt-16 flex flex-col items-center gap-5 border-t border-white/10 pt-8 md:flex-row md:justify-between">
          <div className="flex flex-col items-center gap-1 md:items-start">
            <Logo />
            <p className="text-sm text-white/60">{t('landing.footerMade')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <LangToggle />
            <button type="button" onClick={onSignIn}
              className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white/85 ring-1 ring-white/20 transition hover:bg-white/10">
              <LogIn className="size-4 rtl:-scale-x-100" />
              {t('landing.signIn')}
            </button>
            <button type="button" onClick={onSos}
              className="font-latin inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold text-violet-200 ring-1 ring-violet-300/30 transition hover:bg-white/10">
              {t('landing.footerSos')}
            </button>
          </div>
        </div>
        <p className="mt-8 flex justify-center">
          <span className="font-latin inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-xs font-bold tracking-wide text-white/75 ring-1 ring-white/10">
            <Award className="size-4 text-amber-300" />
            {t('landing.footerCredit')}
          </span>
        </p>
      </div>
    </footer>
  )
}
