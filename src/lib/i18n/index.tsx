import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../types'
import common from './common'
import map from './map'
import report from './report'
import pwa from './pwa'
import sos from './sos'
import alerts from './alerts'

/**
 * i18n: one namespace file per area, each `export default { en: {...}, ur: {...} } satisfies Namespace`.
 * Keys are used as `t('<namespace>.<key>')`, e.g. t('report.recordHint'). `{name}` placeholders are interpolated.
 * Builders add keys ONLY to their own namespace file.
 */
export type Namespace = { en: Record<string, string>; ur: Record<string, string> }
const NAMESPACES: Record<string, Namespace> = { common, map, report, pwa, sos, alerts }

/**
 * Area namespaces used only by their own lazy page: kept out of the startup bundle (cheap phones on /map).
 * App.tsx loads them together with the page chunk (loadNamespaces), so a page never renders before its strings.
 * A key from a namespace that is not loaded yet starts loading it and falls back to the key until it arrives.
 */
const LAZY_NAMESPACES = {
  auth: () => import('./auth'),
  dashboard: () => import('./dashboard'),
  onboarding: () => import('./onboarding'),
  landing: () => import('./landing'),
  admin: () => import('./admin'),
} satisfies Record<string, () => Promise<{ default: Namespace }>>
export type LazyNamespace = keyof typeof LAZY_NAMESPACES

const pendingNs = new Map<string, Promise<void>>()
const nsListeners = new Set<() => void>()

function isLazyNamespace(name: string): name is LazyNamespace {
  return Object.prototype.hasOwnProperty.call(LAZY_NAMESPACES, name)
}

/** Load lazy namespaces (idempotent). Rejects if a chunk cannot be fetched; callers may ignore that. */
export function loadNamespaces(...names: LazyNamespace[]): Promise<void> {
  return Promise.all(names.map((name) => {
    if (NAMESPACES[name]) return undefined
    let p = pendingNs.get(name)
    if (!p) {
      p = LAZY_NAMESPACES[name]().then((m) => {
        NAMESPACES[name] = m.default
        nsListeners.forEach((l) => l())
      })
      p.catch(() => { pendingNs.delete(name) }) // allow a retry later
      pendingNs.set(name, p)
    }
    return p
  })).then(() => undefined)
}

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
  const nsName = key.slice(0, dot)
  const ns = NAMESPACES[nsName]
  if (!ns && isLazyNamespace(nsName)) void loadNamespaces(nsName).catch(() => undefined)
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
  // bumps when a lazy namespace arrives, so components that rendered its keys early re-render with the strings
  const [nsVersion, setNsVersion] = useState(0)
  useEffect(() => {
    const onLoaded = () => setNsVersion((v) => v + 1)
    nsListeners.add(onLoaded)
    return () => { nsListeners.delete(onLoaded) }
  }, [])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nsVersion: new t() identity once lazy strings load
  }), [lang, dir, setLang, nsVersion])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n must be used inside <I18nProvider>')
  return v
}
