import clsx from 'clsx'
import { LayoutDashboard, LogOut, Map as MapIcon, ShieldCheck, User } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useI18n } from '../../lib/i18n'

/** Shared top bar: logo, nav (by role), language toggle, sign out. `floating` = transparent over the map. */
export function AppHeader({ floating, right }: { floating?: boolean; right?: ReactNode }) {
  const { t, toggleLang } = useI18n()
  const { role, signOut, session } = useAuth()
  const nav = useNavigate()
  const link = (to: string, Icon: typeof MapIcon, label: string) => (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      className={({ isActive }) => clsx(
        'inline-flex size-11 items-center justify-center rounded-full',
        isActive ? 'bg-brand-700 text-white' : 'bg-white/90 text-ink hover:bg-white',
      )}
    >
      <Icon className="size-5" />
    </NavLink>
  )
  return (
    <header className={clsx(
      'z-30 flex items-center gap-2 px-3 py-2',
      floating ? 'pointer-events-none absolute inset-x-0 top-0 [&>*]:pointer-events-auto' : 'sticky top-0 border-b border-slate-200 bg-white/95 backdrop-blur',
    )}>
      <button onClick={() => nav('/')} className="flex items-center gap-2 rounded-full bg-white/90 px-3 py-1.5 shadow-sm">
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-700 text-sm font-black text-white">آ</span>
        <span className="font-bold">{t('common.appName')}</span>
      </button>
      <div className="flex-1" />
      {right}
      {session && (
        <nav className="flex items-center gap-1.5">
          {link('/map', MapIcon, t('common.map'))}
          {link('/me', User, t('common.me'))}
          {(role === 'ngo' || role === 'responder' || role === 'admin') && link('/dashboard', LayoutDashboard, t('common.dashboard'))}
          {role === 'admin' && link('/admin', ShieldCheck, t('common.admin'))}
        </nav>
      )}
      <button onClick={toggleLang} className="min-h-11 rounded-full bg-white/90 px-3 text-sm font-semibold shadow-sm hover:bg-white">
        {t('common.language')}
      </button>
      {session && (
        <button aria-label={t('common.signOut')} title={t('common.signOut')} onClick={() => { void signOut().then(() => nav('/')) }}
          className="inline-flex size-11 items-center justify-center rounded-full bg-white/90 shadow-sm hover:bg-white">
          <LogOut className="size-5" />
        </button>
      )}
    </header>
  )
}
