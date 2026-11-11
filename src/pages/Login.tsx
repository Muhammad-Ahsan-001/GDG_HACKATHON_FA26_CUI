import clsx from 'clsx'
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, LogIn, Mail, User, UserPlus, UserRound } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ORG_TYPE_META, ROLE_META, SIGNUP_ROLES, type RoleMeta } from '../components/auth/meta'
import { ErrorBanner, Notice, RoleCard, TextField } from '../components/auth/parts'
import { AppHeader } from '../components/layout/AppHeader'
import { Button } from '../components/ui'
import { homeFor, useAuth } from '../hooks/useAuth'
import { DEMO_ACCOUNTS, DEMO_PASSWORD, type DemoAccount } from '../lib/demoAccounts'
import { useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'
import type { OrgType, Role } from '../lib/types'

type Tab = 'signin' | 'signup'
/** Demo quick-login groups, authorities first. */
const DEMO_GROUPS: Role[] = ['responder', 'ngo', 'citizen', 'admin']
/** Seeded organisation accounts (scripts/seed.mjs) → their org type, for a recognisable icon + colour. */
const DEMO_ORG_TYPE: [prefix: string, type: OrgType][] = [
  ['rescue1122@', 'rescue_1122'], ['fire@', 'fire'], ['police@', 'police'], ['water@', 'water'],
  ['shelter@', 'shelter'], ['foodbank@', 'food_bank'], ['health@', 'health_ngo'],
]
function demoMeta(acc: DemoAccount): RoleMeta {
  const ot = DEMO_ORG_TYPE.find(([prefix]) => acc.email.startsWith(prefix))?.[1]
  return ot ? ORG_TYPE_META[ot] : ROLE_META[acc.role]
}
type SignupRole = Exclude<Role, 'admin'>
/** After auth succeeds we wait for the NEW user's profile to load (so role-guarded routes see the right role). */
interface Pending { uid: string | null; target: 'home' | 'from' | 'signup'; fallbackRole: Role }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseRole(v: string | null): SignupRole | null {
  return v === 'citizen' || v === 'ngo' || v === 'responder' ? v : null
}

async function currentUid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}

export default function Login() {
  const { t, pick } = useI18n()
  const { session, profile, isAnonymous, role, isOnboarded, signInWithPassword, signUp } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [params] = useSearchParams()
  const from = (loc.state as { from?: string } | null)?.from

  const [tab, setTab] = useState<Tab>(params.get('tab') === 'signup' ? 'signup' : 'signin')
  const [signupRole, setSignupRole] = useState<SignupRole | null>(parseRole(params.get('role')))
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // 'signin' | 'signup' | 'anon' | demo email
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  // Navigate once the signed-in user's own profile is loaded; fall back to the known role after a few seconds.
  useEffect(() => {
    if (!pending) return
    const go = (r: Role) => {
      setPending(null)
      setBusy(null)
      // a new citizen account gets the voice onboarding (name + area) first
      if (pending.target === 'signup') nav(r === 'ngo' || r === 'responder' ? '/org/register' : '/onboarding', { replace: true })
      else if (pending.target === 'from' && from && from !== '/login') nav(from, { replace: true })
      else nav(homeFor(r), { replace: true })
    }
    const uid = pending.uid ?? session?.user.id
    if (uid && profile && profile.id === uid) { go(profile.role); return }
    const id = setTimeout(() => go(pending.fallbackRole), 6000)
    return () => clearTimeout(id)
  }, [pending, session, profile, nav, from])

  function switchTab(next: Tab) {
    setTab(next)
    setError(null)
    setNotice(null)
  }

  async function onSignIn(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (!EMAIL_RE.test(email.trim())) { setError('auth.needEmail'); return }
    if (password.length < 6) { setError('auth.needPassword'); return }
    setBusy('signin')
    try {
      await signInWithPassword(email.trim(), password)
      setPending({ uid: await currentUid(), target: from ? 'from' : 'home', fallbackRole: 'citizen' })
    } catch (err) {
      setError(err)
      setBusy(null)
    }
  }

  async function onSignUp(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (!signupRole) { setError('auth.needRole'); return }
    if (name.trim().length < 2) { setError('auth.needName'); return }
    if (!EMAIL_RE.test(email.trim())) { setError('auth.needEmail'); return }
    if (password.length < 6) { setError('auth.needPassword'); return }
    setBusy('signup')
    try {
      const cleanEmail = email.trim()
      await signUp(cleanEmail, password, signupRole, name.trim())
      const { data } = await supabase.auth.getSession()
      const u = data.session?.user
      if (u && !u.is_anonymous && u.email?.toLowerCase() === cleanEmail.toLowerCase()) {
        // make sure the display name lands on the profile even if the signup trigger ignores metadata
        await supabase.from('profiles').update({ display_name: name.trim() }).eq('id', u.id)
        setPending({ uid: u.id, target: 'signup', fallbackRole: signupRole })
      } else {
        // email confirmation is required on this project
        setNotice('auth.checkEmail')
        setTab('signin')
        setBusy(null)
      }
    } catch (err) {
      setError(err)
      setBusy(null)
    }
  }

  async function onDemo(acc: DemoAccount) {
    setError(null)
    setNotice(null)
    setBusy(acc.email)
    try {
      await signInWithPassword(acc.email, DEMO_PASSWORD)
      setPending({ uid: await currentUid(), target: 'home', fallbackRole: acc.role })
    } catch (err) {
      setError(err)
      setBusy(null)
    }
  }

  // guests go through the illiterate-first onboarding, which signs in anonymously after the (mock) SMS step
  function onAnon() {
    setError(null)
    if (session && isOnboarded) { nav(homeFor(role)); return }
    nav('/onboarding')
  }

  const working = busy !== null
  const CitizenIcon = ROLE_META.citizen.icon
  const signedInLabel = profile?.display_name || session?.user.email || ''

  const pwToggle = (
    <button type="button" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t('auth.hidePassword') : t('auth.showPassword')}
      className="inline-flex size-12 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100">
      {showPw ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
    </button>
  )

  return (
    <div className="min-h-full bg-slate-50">
      <AppHeader />
      <main className="mx-auto max-w-xl space-y-5 px-4 py-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {session && !isAnonymous && !pending && (
          <Notice tone="success" icon={UserRound}>
            <div className="font-semibold">{t('auth.signedInAs', { name: signedInLabel })}</div>
            <Button size="sm" className="mt-2" icon={ArrowRight} onClick={() => nav(homeFor(role))}>{t('auth.continue')}</Button>
          </Notice>
        )}

        <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          {/* tabs */}
          <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-100 p-1">
            {([['signin', LogIn, 'auth.signInTab'], ['signup', UserPlus, 'auth.signUpTab']] as const).map(([id, Icon, key]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => switchTab(id)}
                className={clsx(
                  'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl font-bold transition',
                  tab === id ? 'bg-white text-brand-700 shadow' : 'text-slate-600 hover:text-ink',
                )}>
                <Icon className="size-5" /> {t(key)}
              </button>
            ))}
          </div>

          {notice && <Notice tone="success" className="mt-4">{t(notice)}</Notice>}
          <ErrorBanner error={error} onDismiss={() => setError(null)} className="mt-4" />

          {tab === 'signin' ? (
            <form onSubmit={onSignIn} className="mt-4 space-y-4" noValidate>
              <TextField id="login-email" icon={Mail} label={t('auth.email')} type="email" inputMode="email" autoComplete="username"
                value={email} onChange={(e) => setEmail(e.target.value)} ltr placeholder="name@example.com" />
              <TextField id="login-password" icon={KeyRound} label={t('auth.password')} type={showPw ? 'text' : 'password'}
                autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} ltr trailing={pwToggle} />
              <Button type="submit" size="lg" icon={LogIn} loading={busy === 'signin'} disabled={working} className="w-full">
                {busy === 'signin' ? t('auth.signingIn') : t('auth.signInBtn')}
              </Button>
            </form>
          ) : (
            <form onSubmit={onSignUp} className="mt-4 space-y-4" noValidate>
              <div>
                <div className="mb-2 font-bold">{t('auth.whoAreYou')}</div>
                <div className="space-y-2">
                  {SIGNUP_ROLES.map((r) => (
                    <RoleCard key={r} role={r} compact selected={signupRole === r} onClick={() => setSignupRole(r)} disabled={working} />
                  ))}
                </div>
              </div>
              {isAnonymous && <p className="text-xs text-slate-500">{t('auth.guestUpgradeNote')}</p>}
              <TextField id="signup-name" icon={User} label={t('auth.name')} autoComplete="name" value={name}
                onChange={(e) => setName(e.target.value)} placeholder={t('auth.namePh')} />
              <TextField id="signup-email" icon={Mail} label={t('auth.email')} type="email" inputMode="email" autoComplete="email"
                value={email} onChange={(e) => setEmail(e.target.value)} ltr placeholder="name@example.com" />
              <TextField id="signup-password" icon={KeyRound} label={t('auth.password')} type={showPw ? 'text' : 'password'}
                autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} ltr
                hint={t('auth.passwordHint')} trailing={pwToggle} />
              <Button type="submit" size="lg" icon={UserPlus} loading={busy === 'signup'} disabled={working} className="w-full">
                {busy === 'signup' ? t('auth.signingIn') : t('auth.signUpBtn')}
              </Button>
            </form>
          )}
        </section>

        {/* anonymous */}
        <div className="flex items-center gap-3 text-sm font-semibold text-slate-400">
          <span className="h-px flex-1 bg-slate-200" /> {t('auth.or')} <span className="h-px flex-1 bg-slate-200" />
        </div>
        <button type="button" onClick={onAnon} disabled={working}
          className="flex min-h-16 w-full items-center gap-3 rounded-3xl border-2 border-brand-600 bg-brand-50 p-3 text-start transition active:scale-[0.98] disabled:opacity-60">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-brand-700 text-white">
            <CitizenIcon className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-bold text-brand-900">{t('auth.continueAnon')}</span>
            <span className="block text-sm text-brand-900/70">{t('auth.continueAnonHint')}</span>
          </span>
          <ArrowRight className="size-6 shrink-0 text-brand-700 rtl:-scale-x-100" />
        </button>

        {/* demo accounts, grouped: authorities first (the user wants to watch what each authority receives) */}
        <section className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-lg font-bold">{t('auth.demoTitle')}</h2>
          <p className="mb-3 text-sm text-slate-600">{t('auth.demoHint')}</p>
          <div className="space-y-4">
            {DEMO_GROUPS.map((g) => {
              const accounts = DEMO_ACCOUNTS.filter((a) => a.role === g)
              if (accounts.length === 0) return null
              return (
                <div key={g}>
                  <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">{t(`auth.demoGroup_${g}`)}</h3>
                  {g === 'responder' && <p className="mb-2 text-xs text-slate-500">{t('auth.demoAuthoritiesHint')}</p>}
                  <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                    {accounts.map((acc) => {
                      const m = demoMeta(acc)
                      const Icon = m.icon
                      const isBusy = busy === acc.email
                      const isCurrent = session?.user.email === acc.email
                      return (
                        <button key={acc.email} type="button" onClick={() => onDemo(acc)} disabled={working}
                          className={clsx(
                            'flex min-h-16 items-center gap-2 rounded-2xl border-2 p-2 text-start transition active:scale-[0.97] disabled:opacity-60',
                            isCurrent ? 'shadow-md' : 'border-transparent',
                          )}
                          style={{ background: m.soft, borderColor: isCurrent ? m.color : undefined }}>
                          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: m.color }}>
                            {isBusy ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-bold leading-tight">{pick(acc.label_en, acc.label_ur)}</span>
                            <span className="font-latin block truncate text-xs text-slate-600" dir="ltr" lang="en">{acc.email}</span>
                          </span>
                          {isCurrent && <span className="sr-only">{t('auth.current')}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </main>
    </div>
  )
}
