import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SIGNUP_ROLES } from '../components/auth/meta'
import { ErrorBanner, Notice, RoleCard } from '../components/auth/parts'
import { AppHeader } from '../components/layout/AppHeader'
import { homeFor, useAuth } from '../hooks/useAuth'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { Role } from '../lib/types'

type PickRole = Exclude<Role, 'admin'>

export default function Onboarding() {
  const { t } = useI18n()
  const { role, refreshProfile } = useAuth()
  const nav = useNavigate()
  const [busy, setBusy] = useState<PickRole | null>(null)
  const [error, setError] = useState<unknown>(null)
  const isAdmin = role === 'admin'

  async function choose(r: PickRole) {
    if (isAdmin) { nav(homeFor(role)); return }
    setError(null)
    setBusy(r)
    try {
      if (role !== r) {
        await api.setMyRole(r)
        await refreshProfile()
      }
      nav(r === 'citizen' ? '/map' : '/org/register', { replace: true })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-full bg-slate-50">
      <AppHeader />
      <main className="mx-auto max-w-xl px-4 py-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <h1 className="text-3xl font-black">{t('auth.whoAreYou')}</h1>
        <p className="mt-1 text-slate-600">{t('auth.onbSubtitle')}</p>
        {isAdmin && <Notice tone="info" className="mt-4">{t('auth.adminLocked')}</Notice>}
        <ErrorBanner error={error} onDismiss={() => setError(null)} className="mt-4" />
        <div className="mt-5 space-y-3">
          {SIGNUP_ROLES.map((r) => (
            <RoleCard
              key={r}
              role={r}
              current={role === r}
              selected={busy === r}
              loading={busy === r}
              disabled={busy !== null || isAdmin}
              onClick={() => { void choose(r) }}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
