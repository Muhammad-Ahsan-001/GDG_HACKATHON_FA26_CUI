import clsx from 'clsx'
import { m } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { translate, useI18n } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { MapPin } from '../../lib/types'

/** The few public map_pins columns the landing page needs (one request feeds the hero map and the impact strip). */
export type LandingPin = Pick<MapPin, 'id' | 'category' | 'status' | 'urgency' | 'lat' | 'lng' | 'report_count'>

/** null = loading, [] = none / failed (see `failed`). */
export function useLandingPins(): { pins: LandingPin[] | null; failed: boolean } {
  const [pins, setPins] = useState<LandingPin[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      const { data, error } = await supabase.from('map_pins').select('id,category,status,urgency,lat,lng,report_count')
      if (!alive) return
      if (error || !Array.isArray(data)) { setFailed(true); setPins([]); return }
      setPins((data as LandingPin[]).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)))
    })()
    return () => { alive = false }
  }, [])
  return { pins, failed }
}

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * 'webgl' = animated cobe globe. 'static' = SVG globe, no animation loop: reduced motion, data saver,
 * low-memory / low-core phones, or no (hardware) WebGL.
 */
export function detectGlobeMode(): 'webgl' | 'static' {
  if (prefersReducedMotion()) return 'static'
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  if (nav.connection?.saveData) return 'static'
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return 'static'
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 2) return 'static'
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
      ?? c.getContext('webgl', { failIfMajorPerformanceCaveat: true })) as WebGLRenderingContext | null
    if (!gl) return 'static'
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return 'webgl'
  } catch {
    return 'static'
  }
}

/** A line in the current language with the same line in the other language underneath (bilingual, readable by both). */
export function Bi({ k, className, subClassName, as: Tag = 'span' }: {
  k: string; className?: string; subClassName?: string; as?: 'span' | 'h2' | 'h3' | 'p'
}) {
  const { t, lang } = useI18n()
  const other = lang === 'ur' ? 'en' : 'ur'
  return (
    <Tag className={className}>
      <span className="block">{t(k)}</span>
      {/* block keeps the page's alignment; <bdi> keeps the other script's word order right */}
      <span lang={other} className={clsx('block text-[0.6em] font-semibold opacity-60', other === 'ur' ? 'font-urdu leading-[2]' : 'font-latin leading-snug', subClassName)}>
        <bdi dir={other === 'ur' ? 'rtl' : 'ltr'}>{translate(other, k)}</bdi>
      </span>
    </Tag>
  )
}

/** Scroll-reveal (motion whileInView, once). Reduced motion is honoured by the <MotionConfig reducedMotion="user"> above. */
export function Reveal({ children, className, delay = 0, y = 26, as = 'div' }: {
  children: ReactNode; className?: string; delay?: number; y?: number; as?: 'div' | 'li'
}) {
  const C = as === 'li' ? m.li : m.div
  return (
    <C
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.65, delay, ease: [0.22, 0.8, 0.2, 1] }}
    >
      {children}
    </C>
  )
}

/** Section heading: eyebrow + bilingual title + sub line. */
export function SectionHead({ eyebrow, titleKey, subKey, dark, className }: {
  eyebrow?: ReactNode; titleKey: string; subKey?: string; dark?: boolean; className?: string
}) {
  const { t } = useI18n()
  return (
    <Reveal className={clsx('mx-auto max-w-2xl text-center', className)}>
      {eyebrow}
      <Bi as="h2" k={titleKey} className={clsx('text-3xl font-black tracking-tight sm:text-4xl', dark ? 'text-white' : 'text-ink')} />
      {subKey && <p className={clsx('mt-3 text-base sm:text-lg', dark ? 'text-white/70' : 'text-slate-600')}>{t(subKey)}</p>}
    </Reveal>
  )
}
