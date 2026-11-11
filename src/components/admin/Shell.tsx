import clsx from 'clsx'
import {
  Bell, Building2, FileText, LayoutDashboard, Languages, LogOut, Map as MapIcon, RefreshCw, Search, Siren, SquareKanban,
  Users, X, type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useI18n } from '../../lib/i18n'
import { useTimeAgo } from '../ui'
import { SECTIONS, useAdmin, type LiveState, type Section } from './context'

export const SECTION_ICON: Record<Section, LucideIcon> = {
  overview: LayoutDashboard,
  map: MapIcon,
  reports: FileText,
  users: Users,
  orgs: Building2,
  assignments: SquareKanban,
  sos: Siren,
  notifications: Bell,
}

function useBadges(): Partial<Record<Section, { n: number; tone: 'red' | 'amber' | 'muted' }>> {
  const { overview: o } = useAdmin()
  if (!o) return {}
  return {
    reports: o.reports.today ? { n: o.reports.today, tone: 'muted' } : undefined,
    orgs: o.orgs.pending ? { n: o.orgs.pending, tone: 'amber' } : undefined,
    assignments: o.assignments.by_status.alerted ? { n: o.assignments.by_status.alerted, tone: 'red' } : undefined,
    sos: o.sos.active ? { n: o.sos.active, tone: 'red' } : undefined,
    notifications: o.notifications.today ? { n: o.notifications.today, tone: 'muted' } : undefined,
  }
}

const BADGE_TONE = {
  red: 'bg-red-500 text-white',
  amber: 'bg-amber-400 text-amber-950',
  muted: 'bg-white/12 text-white/80',
}

export function LivePill({ live, className }: { live: LiveState; className?: string }) {
  const { t } = useI18n()
  const tone = live === 'live' ? 'text-emerald-600 bg-emerald-50 ring-emerald-200'
    : live === 'connecting' ? 'text-amber-600 bg-amber-50 ring-amber-200' : 'text-red-600 bg-red-50 ring-red-200'
  return (
    <span role="status" title={live === 'live' ? t('admin.liveHint') : undefined}
      className={clsx('inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-xs font-bold ring-1', tone, className)}>
      <span className={clsx(live === 'live' ? 'adm-live-dot' : 'inline-flex size-2 rounded-full bg-current')} />
      {t(`admin.${live}`)}
    </span>
  )
}

function SearchBox({ className, inputRef }: { className?: string; inputRef?: RefObject<HTMLInputElement | null> }) {
  const { t } = useI18n()
  const { search, setSearch, section, go } = useAdmin()
  const [val, setVal] = useState(search)
  useEffect(() => { setVal(search) }, [search])
  // debounce typing into the shared search (reports / people panels react to it)
  useEffect(() => {
    if (val === search) return
    const h = setTimeout(() => {
      setSearch(val)
      if (val && section !== 'reports' && section !== 'users') go('reports', { search: val })
    }, 350)
    return () => clearTimeout(h)
  }, [val, search, setSearch, section, go])
  return (
    <label className={clsx('relative flex min-w-0 items-center', className)}>
      <span className="sr-only">{t('admin.searchLabel')}</span>
      <Search className="pointer-events-none absolute start-3 size-4.5 text-slate-400" />
      <input
        ref={inputRef}
        type="search"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setVal(''); setSearch('') } }}
        placeholder={t('admin.search')}
        className="min-h-10 w-full rounded-xl border-0 bg-slate-100/80 pe-16 ps-10 text-sm text-slate-900 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-brand-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {val ? (
        <button type="button" onClick={() => { setVal(''); setSearch('') }} aria-label={t('admin.clearSearch')}
          className="absolute end-1.5 inline-flex size-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200">
          <X className="size-4" />
        </button>
      ) : (
        <kbd className="font-latin pointer-events-none absolute end-2.5 hidden rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-400 ring-1 ring-slate-200 sm:block" title={t('admin.searchKey')}>/</kbd>
      )}
    </label>
  )
}

function NavList({ onPick, compact }: { onPick?: () => void; compact?: boolean }) {
  const { t } = useI18n()
  const { section, go } = useAdmin()
  const badges = useBadges()
  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (compact) activeRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [section, compact])
  if (compact) {
    return (
      <nav aria-label={t('admin.navLabel')} className="adm-scroll -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2">
        {SECTIONS.map((s) => {
          const Icon = SECTION_ICON[s]
          const b = badges[s]
          const active = s === section
          return (
            <button key={s} ref={active ? activeRef : undefined} type="button" onClick={() => go(s)} aria-current={active ? 'page' : undefined}
              className={clsx('inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition',
                active ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200')}>
              <Icon className="size-4" />
              {t(`admin.nav_${s}`)}
              {b && <span className={clsx('font-latin rounded-full px-1.5 text-[11px] font-bold tabular-nums',
                b.tone === 'muted' ? (active ? 'bg-white/20' : 'bg-slate-100 text-slate-600') : BADGE_TONE[b.tone])}>{b.n}</span>}
            </button>
          )
        })}
      </nav>
    )
  }
  return (
    <nav aria-label={t('admin.navLabel')} className="space-y-0.5">
      {SECTIONS.map((s) => {
        const Icon = SECTION_ICON[s]
        const b = badges[s]
        const active = s === section
        return (
          <button key={s} type="button" onClick={() => { go(s); onPick?.() }} aria-current={active ? 'page' : undefined}
            className={clsx(
              'group relative flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-[14px] font-semibold transition',
              active ? 'bg-white/10 text-white' : 'text-white/65 hover:bg-white/5 hover:text-white',
            )}>
            {active && <span className="absolute inset-y-2 start-0 w-1 rounded-full bg-brand-500" />}
            <Icon className={clsx('size-[18px] shrink-0', active ? 'text-brand-500' : 'text-white/50 group-hover:text-white/80')} />
            <span className="flex-1 truncate">{t(`admin.nav_${s}`)}</span>
            {b && (
              <span className={clsx('font-latin inline-flex min-w-6 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums', BADGE_TONE[b.tone])}>
                {b.n}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}

function Logo({ dark }: { dark?: boolean }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2.5">
      <span className="inline-flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-base font-black text-white shadow-sm">آ</span>
      <div className="leading-tight">
        <div className={clsx('font-black tracking-tight', dark ? 'text-white' : 'text-slate-900')}>{t('common.appName')}</div>
        <div className={clsx('text-[11px] font-semibold', dark ? 'text-white/50' : 'hidden text-slate-500 sm:block')}>{t('admin.console')}</div>
      </div>
    </div>
  )
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { t, toggleLang } = useI18n()
  const { profile, signOut, session } = useAuth()
  const { live, refresh, overview } = useAdmin()
  const nav = useNavigate()
  const ago = useTimeAgo()
  const searchRef = useRef<HTMLInputElement>(null)
  const mobileSearchRef = useRef<HTMLInputElement>(null)
  const [spin, setSpin] = useState(false)

  // "/" focuses search (unless typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      e.preventDefault()
      const target = window.innerWidth >= 1024 ? searchRef.current : mobileSearchRef.current
      target?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const doRefresh = () => {
    setSpin(true)
    refresh()
    setTimeout(() => setSpin(false), 700)
  }
  const name = profile?.display_name || session?.user.email || t('common.admin')
  const iconBtn = 'inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100'

  return (
    <div className="adm-root flex h-full min-h-0 bg-slate-50">
      {/* sidebar (desktop) */}
      <aside className="adm-side-scroll sticky top-0 hidden h-dvh w-[260px] shrink-0 flex-col overflow-y-auto bg-[var(--adm-side)] px-3 py-4 lg:flex">
        <div className="px-2 pb-5"><Logo dark /></div>
        <NavList />
        <div className="flex-1" />
        <div className="mt-6 space-y-1 border-t border-white/10 pt-4">
          <button type="button" onClick={() => nav('/map')}
            className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold text-white/65 hover:bg-white/5 hover:text-white">
            <MapIcon className="size-4" /> {t('common.map')}
          </button>
          <button type="button" onClick={() => nav('/dashboard')}
            className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold text-white/65 hover:bg-white/5 hover:text-white">
            <LayoutDashboard className="size-4" /> {t('common.dashboard')}
          </button>
          <div className="mt-2 flex items-center gap-3 rounded-xl bg-white/5 p-2.5">
            <span className="font-latin inline-flex size-9 items-center justify-center rounded-full bg-brand-700 text-xs font-black text-white">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[11px] text-white/45">{t('admin.signedInAs')}</div>
              <div className="font-latin truncate text-sm font-semibold text-white">{name}</div>
            </div>
            <button type="button" aria-label={t('common.signOut')} title={t('common.signOut')}
              onClick={() => { void signOut().then(() => nav('/')) }}
              className="inline-flex size-9 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md lg:px-6 lg:pt-0">
          <div className="flex min-h-14 items-center gap-2 lg:min-h-16 lg:gap-3">
            <div className="lg:hidden"><Logo /></div>
            <SearchBox inputRef={searchRef} className="hidden max-w-xl flex-1 lg:flex" />
            <div className="flex-1" />
            <LivePill live={live} />
            {overview && (
              <span className="hidden text-xs text-slate-400 xl:inline">{t('admin.updated', { t: ago(overview.generated_at) })}</span>
            )}
            <button type="button" onClick={doRefresh} aria-label={t('admin.refresh')} title={t('admin.refresh')} className={iconBtn}>
              <RefreshCw className={clsx('size-[18px]', spin && 'animate-spin')} />
            </button>
            <button type="button" onClick={toggleLang}
              className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">
              <Languages className="size-4" /> {t('common.language')}
            </button>
            <button type="button" aria-label={t('common.signOut')} title={t('common.signOut')}
              onClick={() => { void signOut().then(() => nav('/')) }} className={clsx(iconBtn, 'lg:hidden')}>
              <LogOut className="size-[18px]" />
            </button>
          </div>
          <div className="space-y-2 pb-1 lg:hidden">
            <SearchBox inputRef={mobileSearchRef} />
            <NavList compact />
          </div>
        </header>

        <main className="adm-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px] px-3 py-4 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-5 lg:px-8 lg:py-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
