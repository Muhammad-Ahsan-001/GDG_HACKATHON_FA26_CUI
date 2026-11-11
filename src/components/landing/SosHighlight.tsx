import { ArrowRight, AudioLines, FileLock2, Hand, MapPin, Shield, ShieldCheck, VolumeX, type LucideIcon } from 'lucide-react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { Bi, Reveal } from './shared'

const POINTS: [LucideIcon, string, string][] = [
  [VolumeX, 'landing.sosP1Title', 'landing.sosP1Body'],
  [AudioLines, 'landing.sosP2Title', 'landing.sosP2Body'],
  [Shield, 'landing.sosP3Title', 'landing.sosP3Body'],
  [FileLock2, 'landing.sosP4Title', 'landing.sosP4Body'],
]

export function SosHighlight({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n()
  const safety = CATEGORY_META.safety
  return (
    <section className="bg-white px-4 py-20 sm:py-24 lg:px-8">
      <Reveal className="mx-auto max-w-6xl">
        <div className="relative overflow-hidden rounded-[2rem] bg-linear-to-br from-[#1e1240] via-[#24145a] to-[#0f1a3d] p-6 text-white shadow-2xl shadow-violet-950/30 sm:p-10 lg:p-12">
          <div aria-hidden className="pointer-events-none absolute -end-24 -top-24 size-96 rounded-full bg-[radial-gradient(circle,rgba(167,139,250,.35),transparent_65%)]" />
          <div className="relative grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-violet-100 ring-1 ring-white/15">
                <ShieldCheck className="size-4" style={{ color: '#c4b5fd' }} />
                {t('landing.sosEyebrow')}
              </span>
              <Bi as="h2" k="landing.sosTitle" className="mt-4 text-3xl font-black tracking-tight sm:text-4xl" />
              <p className="mt-4 max-w-xl text-base leading-relaxed text-violet-100/85 sm:text-lg">{t('landing.sosBody')}</p>

              <ul className="mt-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                {POINTS.map(([Icon, title, body]) => (
                  <li key={title} className="flex items-start gap-3 rounded-2xl bg-white/[0.06] p-3 ring-1 ring-white/10">
                    <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: safety.color }}>
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-bold leading-tight">{t(title)}</span>
                      <span className="mt-0.5 block text-sm leading-snug text-violet-100/70">{t(body)}</span>
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-6 flex items-start gap-2 text-sm text-violet-100/80">
                <Hand className="mt-0.5 size-4 shrink-0" />
                {t('landing.sosHow')}
              </p>
              <button type="button" onClick={onOpen}
                className="mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-5 text-base font-bold text-[#24145a] shadow-lg transition hover:bg-violet-50 active:scale-95">
                {t('landing.sosOpen')}
                <ArrowRight className="size-5 rtl:-scale-x-100" />
              </button>
            </div>

            {/* calm illustration: shield inside soft listening rings, with the police alert it sends */}
            <div aria-hidden className="relative mx-auto flex aspect-square w-full max-w-sm items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-violet-300/15" />
              <span className="absolute inset-[12%] rounded-full border border-violet-300/20" />
              <span className="absolute inset-[24%] rounded-full border border-violet-300/25 bg-violet-400/5" />
              <span className="relative inline-flex size-28 items-center justify-center rounded-[2rem] text-white shadow-2xl"
                style={{ background: `linear-gradient(160deg, #8b5cf6, ${safety.color})`, boxShadow: '0 24px 60px -16px rgba(124,58,237,.7)' }}>
                <ShieldCheck className="size-14" />
              </span>
              <span className="absolute bottom-[8%] start-1/2 inline-flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-2xl bg-white px-3 py-2 text-sm font-bold text-[#24145a] shadow-xl rtl:translate-x-1/2">
                <span className="inline-flex size-7 items-center justify-center rounded-lg text-white" style={{ background: safety.color }}>
                  <Shield className="size-4" />
                </span>
                {t('landing.sosP3Title')}
                <MapPin className="size-4 text-violet-500" />
              </span>
              <span className="absolute end-[6%] top-[12%] inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-violet-100 ring-1 ring-white/15">
                <VolumeX className="size-3.5" /> {t('landing.sosP1Title')}
              </span>
              <span className="absolute start-[4%] top-[34%] inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-violet-100 ring-1 ring-white/15">
                <AudioLines className="size-3.5" /> {t('landing.sosP2Title')}
              </span>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
