import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { loadMapCanvas } from './components/map/loadMapCanvas'
import { onboardingSeen } from './components/onboarding/progress'
import { PwaLayer } from './components/pwa/PwaLayer'
import { Spinner } from './components/ui'
import { AuthProvider, homeFor, isProfileOnboarded, useAuth } from './hooks/useAuth'
import { I18nProvider, loadNamespaces, type LazyNamespace } from './lib/i18n'
import type { Role } from './lib/types'

/**
 * A lazy page whose area strings (lazy i18n namespaces) download in parallel with its chunk, so it never renders
 * raw keys. A failed strings chunk is not fatal: translate() retries it and the page re-renders when it arrives.
 */
function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, ...ns: LazyNamespace[]) {
  if (ns.length === 0) return lazy(load)
  return lazy(() => Promise.all([load(), loadNamespaces(...ns).catch(() => undefined)]).then(([m]) => m))
}

const Landing = lazyPage(() => import('./pages/Landing'), 'landing')
const Login = lazyPage(() => import('./pages/Login'), 'auth')
const Onboarding = lazyPage(() => import('./pages/Onboarding'), 'onboarding')
// the Leaflet canvas chunk starts downloading together with the map page (no waterfall); the shell paints first
const MapPage = lazy(() => {
  void loadMapCanvas().catch(() => undefined)
  return import('./pages/MapPage')
})
const MePage = lazyPage(() => import('./pages/MePage'), 'auth')
const Dashboard = lazyPage(() => import('./pages/Dashboard'), 'dashboard')
const OrgRegister = lazyPage(() => import('./pages/OrgRegister'), 'auth')
const Admin = lazyPage(() => import('./pages/Admin'), 'admin', 'auth')
const SosPage = lazy(() => import('./pages/SosPage'))

function FullScreenSpinner() {
  return <div className="flex h-full items-center justify-center text-brand-700"><Spinner className="size-10" /></div>
}

/** Routes a not-yet-onboarded citizen is never pulled away from (SOS must open instantly, always). */
const ONBOARDING_EXEMPT = new Set(['/onboarding', '/sos'])

let anonSignIn: Promise<void> | null = null

/** No session on a route that must work immediately (SOS): start an anonymous citizen session instead of /login. */
function AnonSignIn({ from }: { from: string }) {
  const { signInAnonymously } = useAuth()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    // shared promise: StrictMode's double effect run must not create two anonymous users
    anonSignIn ??= signInAnonymously().finally(() => { anonSignIn = null })
    anonSignIn.catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount (the auth context re-creates the function)
  }, [])
  if (failed) return <Navigate to="/login" replace state={{ from }} />
  return <FullScreenSpinner />
}

/**
 * Requires a session; optionally restricts roles. Anonymous users are citizens.
 * `anon`: with no session, sign in anonymously right here instead of sending the user to /login.
 * A signed-in citizen whose profile.onboarded_at is null (and not a demo account) is sent to /onboarding once
 * per account and device (the flag is set by the Onboarding page), so it can never loop.
 */
function RequireAuth({ children, roles, anon }: { children: ReactNode; roles?: Role[]; anon?: boolean }) {
  const { session, profile, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <FullScreenSpinner />
  if (!session) return anon ? <AnonSignIn from={loc.pathname + loc.search} /> : <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (roles && profile && !roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />
  const ownProfile = profile && profile.id === session.user.id ? profile : null
  if (ownProfile && !isProfileOnboarded(ownProfile) && !ONBOARDING_EXEMPT.has(loc.pathname) && !onboardingSeen(ownProfile.id)) {
    return <Navigate to="/onboarding" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          {/* global PWA UI: offline pill, update + install prompts, toasts (incl. foreground push), push token sync */}
          <PwaLayer />
          <Suspense fallback={<FullScreenSpinner />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              {/* no session needed: onboarding signs in anonymously after the (mock) SMS step */}
              <Route path="/onboarding" element={<Onboarding />} />
              {/* MapPage renders the report sheet (/report) and pin sheet (/pin/:id) over the map */}
              <Route path="/map" element={<RequireAuth><MapPage /></RequireAuth>} />
              <Route path="/report" element={<RequireAuth><MapPage /></RequireAuth>} />
              <Route path="/pin/:id" element={<RequireAuth><MapPage /></RequireAuth>} />
              <Route path="/me" element={<RequireAuth><MePage /></RequireAuth>} />
              <Route path="/dashboard" element={<RequireAuth roles={['ngo', 'responder', 'admin']}><Dashboard /></RequireAuth>} />
              <Route path="/org/register" element={<RequireAuth roles={['ngo', 'responder']}><OrgRegister /></RequireAuth>} />
              {/* SOS (women's safety): discreet listening + threat detection -> police alert */}
              <Route path="/sos" element={<RequireAuth anon><SosPage /></RequireAuth>} />
              <Route path="/admin" element={<RequireAuth roles={['admin']}><Admin /></RequireAuth>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  )
}
