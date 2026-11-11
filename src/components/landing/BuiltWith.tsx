import { BellRing, BrainCircuit, Database, Map as MapIcon, Triangle, type LucideIcon } from 'lucide-react'
import { useI18n } from '../../lib/i18n'
import { AiLabel } from '../ui'
import { Reveal, SectionHead } from './shared'

const TECH: [LucideIcon, string, string, string][] = [
  [BrainCircuit, 'landing.builtOpenai', 'landing.builtOpenaiBody', '#0f172a'],
  [Database, 'landing.builtSupabase', 'landing.builtSupabaseBody', '#0f766e'],
  [BellRing, 'landing.builtFcm', 'landing.builtFcmBody', '#c2410c'],
  [MapIcon, 'landing.builtOsm', 'landing.builtOsmBody', '#15803d'],
  [Triangle, 'landing.builtVercel', 'landing.builtVercelBody', '#334155'],
]

export function BuiltWith() {
  const { t } = useI18n()
  return (
    <section className="bg-white pb-20 sm:pb-24">
      <div className="mx-auto max-w-6xl px-4 lg:px-8">
        <SectionHead titleKey="landing.builtTitle" />
        <ul className="mt-10 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-5">
          {TECH.map(([Icon, name, body, color], i) => (
            <Reveal as="li" key={name} delay={i * 0.05} y={16}>
              <div className="flex h-full items-start gap-3 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200 lg:flex-col">
                <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: color }}>
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="font-latin block font-black leading-tight text-ink">{t(name)}</span>
                  <span className="mt-1 block text-sm leading-snug text-slate-600">{t(body)}</span>
                </span>
              </div>
            </Reveal>
          ))}
        </ul>
        <Reveal delay={0.1}>
          <p className="mx-auto mt-6 flex max-w-3xl flex-wrap items-center justify-center gap-2 rounded-2xl bg-violet-50 px-4 py-3 text-center text-sm font-medium text-violet-900 ring-1 ring-violet-100">
            <AiLabel />
            <span>{t('landing.aiDisclosure')}</span>
          </p>
        </Reveal>
      </div>
    </section>
  )
}
