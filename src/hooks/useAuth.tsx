import type { Session, User } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Organization, Profile, Role } from '../lib/types'

interface AuthCtx {
  session: Session | null
  user: User | null
  profile: Profile | null
  /** organisations owned by the current user (ngo / responder) */
  orgs: Organization[]
  loading: boolean
  isAnonymous: boolean
  role: Role | null
  /**
   * True when the signed-in user needs no citizen onboarding: organisations / admins, demo accounts,
   * and citizens whose profile.onboarded_at is set (complete_onboarding RPC). False while signed out.
   */
  isOnboarded: boolean
  refreshProfile: () => Promise<void>
  signInAnonymously: () => Promise<void>
  signInWithPassword: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, role: Exclude<Role, 'admin'>, displayName: string) => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [loading, setLoading] = useState(true)

  const loadProfile = useCallback(async (uid: string | undefined) => {
    if (!uid) { setProfile(null); setOrgs([]); return }
    // profile row is created by a DB trigger on signup; retry briefly in case it is not visible yet
    for (let i = 0; i < 3; i++) {
      const { data } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
      if (data) { setProfile(data as Profile); break }
      await new Promise((r) => setTimeout(r, 400))
    }
    const { data: o } = await supabase.from('org_directory').select('*').eq('owner_id', uid)
    setOrgs((o as Organization[] | null) ?? [])
  }, [])

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      setSession(data.session)
      await loadProfile(data.session?.user.id)
      if (mounted) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      // defer DB calls out of the auth callback (supabase-js recommendation)
      setTimeout(() => { void loadProfile(s?.user.id) }, 0)
    })
    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [loadProfile])

  const value = useMemo<AuthCtx>(() => ({
    session,
    user: session?.user ?? null,
    profile,
    orgs,
    loading,
    isAnonymous: Boolean(session?.user?.is_anonymous),
    role: profile?.role ?? null,
    isOnboarded: isProfileOnboarded(profile),
    // read the live session (not this render's): callers may refresh right after signing in
    async refreshProfile() {
      const { data } = await supabase.auth.getSession()
      await loadProfile(data.session?.user.id ?? session?.user.id)
    },
    async signInAnonymously() {
      const { error } = await supabase.auth.signInAnonymously({ options: { data: { role: 'citizen' } } })
      if (error) throw error
    },
    async signInWithPassword(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    },
    async signUp(email, password, role, displayName) {
      const { error } = await supabase.auth.signUp({
        email, password, options: { data: { role, display_name: displayName } },
      })
      if (error) throw error
    },
    async signOut() {
      await supabase.auth.signOut()
      setProfile(null)
      setOrgs([])
    },
  }), [session, profile, orgs, loading, loadProfile])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>')
  return v
}

/** See AuthCtx.isOnboarded. `select('*')` already returns home_area / onboarded_at once the 1b migration is live. */
export function isProfileOnboarded(profile: Profile | null | undefined): boolean {
  if (!profile) return false
  return profile.role !== 'citizen' || Boolean(profile.onboarded_at) || profile.is_demo
}

/** Where a user should land after login, by role. */
export function homeFor(role: Role | null | undefined): string {
  if (role === 'ngo' || role === 'responder') return '/dashboard'
  if (role === 'admin') return '/admin'
  return '/map'
}
