import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../types'
import common from './common'
import map from './map'
import report from './report'
import auth from './auth'
import dashboard from './dashboard'
import pwa from './pwa'
import sos from './sos'
import onboarding from './onboarding'

/**
 * i18n: one namespace file per area, each `export default { en: {...}, ur: {...} } satisfies Namespace`.
 * Keys are used as `t('<namespace>.<key>')`, e.g. t('report.recordHint'). `{name}` placeholders are interpolated.
 * Builders add keys ONLY to their own namespace file.
 */
export type Namespace = { en: Record<string, string>; ur: Record<string, string> }
const NAMESPACES: Record<string, Namespace> = { common, map, report, auth, dashboard, pwa, sos, onboarding }

const STORAGE_KEY = 'awaaz.lang'

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'ur' || v === 'en') return v
  } catch { /* storage unavailable */ }
  return 'ur'
}

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const dot = key.indexOf('.')
  const ns = NAMESPACES[key.slice(0, dot)]
  const k = key.slice(dot + 1)
  let s = ns?.[lang]?.[k] ?? ns?.en?.[k] ?? key
  if (vars) for (const [name, val] of Object.entries(vars)) s = s.split(`{${name}}`).join(String(val))
  return s
}

interface I18nCtx {
  lang: Lang
  dir: 'rtl' | 'ltr'
  setLang: (l: Lang) => void
  toggleLang: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
  /** pick the right field of a bilingual pair, falling back to the other language */
  pick: (en: string | null | undefined, ur: string | null | undefined) => string
}

const Ctx = createContext<I18nCtx | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang)
  const dir = lang === 'ur' ? 'rtl' : 'ltr'

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = dir
  }, [lang, dir])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
  }, [])

  const value = useMemo<I18nCtx>(() => ({
    lang,
    dir,
    setLang,
    toggleLang: () => setLang(lang === 'ur' ? 'en' : 'ur'),
    t: (key, vars) => translate(lang, key, vars),
    pick: (en, ur) => (lang === 'ur' ? ur || en : en || ur) || '',
  }), [lang, dir, setLang])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n must be used inside <I18nProvider>')
  return v
}
