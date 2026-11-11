import clsx from 'clsx'
import { ArrowRight, ChevronDown, LayoutDashboard, LogIn, Map as MapIcon, Mic, ShieldCheck } from 'lucide-react'
import { LazyMotion, MotionConfig } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BuiltWith } from '../components/landing/BuiltWith'
import { LangToggle, Logo } from '../components/landing/Brand'
import { HeroStage } from '../components/landing/HeroStage'
import { HowItWorks } from '../components/landing/HowItWorks'
import { ImpactStrip } from '../components/landing/ImpactStrip'
import { LandingFooter } from '../components/landing/LandingFooter'
import { Responders } from '../components/landing/Responders'
import { useLandingPins } from '../components/landing/shared'
import { SosHighlight } from '../components/landing/SosHighlight'
import '../components/landing/landing.css'
import { VoiceGuide } from '../components/voice/VoiceGuide'
import { homeFor, useAuth } from '../hooks/useAuth'
import { translate, useI18n } from '../lib/i18n'
import { stopVoice } from '../lib/voice/player'

const loadMotion = () => import('../components/landing/motionFeatures').then((m) => m.default)

/** Keeps each phrase of a headline on one line, so it only wraps between phrases ("Your voice." / "Your neighbourhood."). */
function Phrases({ text }: { text: string }) {
  const parts = text.split(/(?<=[.،,])\s+/)
  return <>{parts.map((p, i) => <span key={i}>{i > 0 && ' '}<span className="inline-block">{p}</span></span>)}</>
}

export default function Landing() {
  const { t, lang } = useI18n()
  const { session, role, loading, isOnboarded } = useAuth()
  const nav = useNavigate()
  const { pins, failed } = useLandingPins()
  const ready = Boolean(session) && isOnboarded
  const other = lang === 'ur' ? 'en' : 'ur'

  // floating "Start" bar on phones once the hero button has scrolled away
  const ctaRef = useRef<HTMLButtonElement>(null)
  const [ctaVisible, setCtaVisible] = useState(true)
  useEffect(() => {
    const el = ctaRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setCtaVisible(e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Start → onboarding (it signs in anonymously after the mock SMS); already set up → straight home.
  function start() {
    stopVoice()
    nav(ready ? homeFor(role) : '/onboarding')
  }
  function go(path: string) {
    stopVoice()
    nav(path)
  }

  const home = homeFor(role)
  const startLabel = !ready ? t('landing.start')
    : home === '/dashboard' ? t('landing.openDashboard')
    : home === '/admin' ? t('landing.openAdmin')
    : t('landing.openMap')
  const StartIcon = !ready ? Mic : home === '/map' ? MapIcon : home === '/admin' ? ShieldCheck : LayoutDashboard
  const mapLabel = ready ? startLabel : t('landing.stageOpen')

  return (
    <LazyMotion features={loadMotion} strict>
      <MotionConfig reducedMotion="user">
        <div className="lp-root min-h-full">
          {/* ---------------- hero ---------------- */}
          <section className="lp-sky relative isolate flex min-h-svh flex-col overflow-hidden">
            <div aria-hidden className="lp-stars pointer-events-none absolute inset-0" />
            <div aria-hidden className="lp-grain pointer-events-none absolute inset-0" />
            <div aria-hidden className="lp-horizon pointer-events-none absolute inset-x-0 bottom-0 h-1/3" />

            <header className="relative z-20 mx-auto flex w-full max-w-6xl items-center gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] lg:px-8 lg:pt-5">
              <Logo />
              <span className="flex-1" />
              <LangToggle />
              <button type="button" onClick={() => go('/login')} aria-label={t('landing.signIn')} title={t('landing.signIn')}
                className="inline-flex size-11 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/15 transition hover:bg-white/20 active:scale-95 lg:hidden">
                <LogIn className="size-5 rtl:-scale-x-100" />
              </button>
              <button type="button" onClick={() => go('/login')}
                className="hidden min-h-11 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-semibold text-white ring-1 ring-white/15 transition hover:bg-white/20 lg:inline-flex">
                <LogIn className="size-4 rtl:-scale-x-100" />
                {t('landing.signIn')}
              </button>
            </header>

            <div className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-5 px-4 pb-14 pt-3 lg:grid-cols-[1.05fr_1fr] lg:gap-12 lg:px-8 lg:pb-16">
              <div className="lg:order-2">
                <HeroStage pins={pins} onOpen={start} openLabel={mapLabel} />
              </div>

              <div className="text-center lg:order-1 lg:text-left lg:rtl:text-right">
                <p className="hidden items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-teal-100 ring-1 ring-white/15 sm:inline-flex sm:text-sm">
                  <span className="lp-live-dot" />
                  {t('landing.liveIn')}
                </p>

                <h1 className="sm:mt-3">
                  <span lang="ur" dir="rtl" className="font-urdu block text-[2.3rem] font-bold leading-[1.75] text-white sm:text-5xl lg:text-[3.6rem] lg:leading-[1.7]">
                    <Phrases text={translate('ur', 'landing.headlinePrimary')} />
                  </span>
                  <span lang="en" dir="ltr" className="font-latin lp-grad-text mt-1 block text-balance text-[1.7rem] font-black leading-[1.15]! tracking-tight sm:text-4xl lg:text-5xl">
                    <Phrases text={translate('en', 'landing.headlinePrimary')} />
                  </span>
                </h1>

                <p className="mx-auto mt-3 max-w-xl text-[0.95rem] leading-relaxed text-white/80 sm:mt-4 sm:text-lg lg:mx-0">{t('landing.valueProp')}</p>

                <div className="mx-auto mt-5 max-w-md sm:mt-6 lg:mx-0 lg:max-w-lg">
                  <button ref={ctaRef} type="button" onClick={start} disabled={loading}
                    className="lp-cta-shine group flex min-h-[4.75rem] w-full items-center gap-3 rounded-full bg-white py-2 pe-5 ps-2 text-start text-[1.35rem] font-black leading-tight text-[#06213a] shadow-[0_20px_50px_-12px_rgba(45,212,191,.45)] transition hover:bg-teal-50 active:scale-[0.98] disabled:opacity-80 sm:text-2xl">
                    <span className="relative inline-flex size-[3.75rem] shrink-0 items-center justify-center rounded-full bg-linear-to-b from-amber-400 to-amber-500 text-white shadow-lg shadow-amber-500/40">
                      {!ready && <><span className="lp-cta-ring" /><span className="lp-cta-ring lp-d2" /></>}
                      <StartIcon className="relative size-8" />
                    </span>
                    <span className="min-w-0 flex-1">{startLabel}</span>
                    <ArrowRight className="size-7 shrink-0 transition group-hover:translate-x-1 rtl:-scale-x-100 rtl:group-hover:-translate-x-1" />
                  </button>
                  <p className="mt-2.5 text-sm text-white/65">{t('landing.startSub')}</p>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-3 sm:mt-5 lg:justify-start">
                  <VoiceGuide prompt="welcome" size={52} className="bg-amber-300/15! text-amber-100! ring-amber-300/40!" />
                  <button type="button" onClick={() => go('/login')}
                    className="inline-flex min-h-[3.25rem] items-center gap-2 rounded-full px-4 text-sm font-semibold text-white/85 ring-1 ring-white/20 transition hover:bg-white/10 lg:hidden">
                    <LogIn className="size-4 rtl:-scale-x-100" />
                    {t('landing.signInShort')}
                  </button>
                </div>
                <p lang={other} className={clsx('mt-3 text-xs text-white/45', other === 'ur' ? 'font-urdu' : 'font-latin')}>
                  <bdi dir={other === 'ur' ? 'rtl' : 'ltr'}>{translate(other, 'landing.valueProp')}</bdi>
                </p>
              </div>
            </div>

            <a href="#how" aria-label={t('landing.scrollHint')}
              className="lp-bounce absolute bottom-3 start-1/2 z-10 hidden -translate-x-1/2 items-center gap-1 text-xs font-semibold text-white/55 hover:text-white/80 sm:inline-flex rtl:translate-x-1/2">
              {t('landing.scrollHint')} <ChevronDown className="size-4" />
            </a>
          </section>

          {/* ---------------- below the fold ---------------- */}
          <main className="relative">
            <div className="bg-white"><HowItWorks /></div>
            <ImpactStrip pins={pins} failed={failed} />
            <Responders onRegister={() => go('/login?tab=signup&role=responder')} />
            <SosHighlight onOpen={() => go('/sos')} />
            <BuiltWith />
          </main>

          <LandingFooter onStart={start} startLabel={startLabel} onSignIn={() => go('/login')} onSos={() => go('/sos')} />

          {/* phones: Start stays one tap away */}
          <div className={clsx('lp-float fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 lg:hidden', ctaVisible && 'is-hidden')}>
            <button type="button" onClick={start} tabIndex={ctaVisible ? -1 : 0}
              className="mx-auto flex min-h-16 w-full max-w-md items-center gap-3 rounded-full bg-[#06213a] py-2 pe-5 ps-2 text-lg font-black text-white shadow-2xl shadow-black/40 ring-1 ring-white/15 active:scale-[0.98]">
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-linear-to-b from-amber-400 to-amber-500">
                <StartIcon className="size-6" />
              </span>
              <span className="min-w-0 flex-1 text-start">{startLabel}</span>
              <ArrowRight className="size-6 shrink-0 rtl:-scale-x-100" />
            </button>
          </div>
        </div>
      </MotionConfig>
    </LazyMotion>
  )
}
