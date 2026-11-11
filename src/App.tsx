import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { PwaLayer } from './components/pwa/PwaLayer'
import { Spinner } from './components/ui'
import { AuthProvider, homeFor, useAuth } from './hooks/useAuth'
import { I18nProvider } from './lib/i18n'
import type { Role } from './lib/types'

const Landing = lazy(() => import('./pages/Landing'))
const Login = lazy(() => import('./pages/Login'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const MapPage = lazy(() => import('./pages/MapPage'))
const MePage = lazy(() => import('./pages/MePage'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const OrgRegister = lazy(() => import('./pages/OrgRegister'))
const Admin = lazy(() => import('./pages/Admin'))
const SosPage = lazy(() => import('./pages/SosPage'))

function FullScreenSpinner() {
  return <div className="flex h-full items-center justify-center text-brand-700"><Spinner className="size-10" /></div>
}

/** Requires a session; optionally restricts roles. Anonymous users are citizens. */
function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { session, profile, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <FullScreenSpinner />
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (roles && profile && !roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />
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
              <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
              {/* MapPage renders the report sheet (/report) and pin sheet (/pin/:id) over the map */}
              <Route path="/map" element={<RequireAuth><MapPage /></RequireAuth>} />
              <Route path="/report" element={<RequireAuth><MapPage /></RequireAuth>} />
              <Route path="/pin/:id" element={<RequireAuth><MapPage /></RequireAuth>} />
              <Route path="/me" element={<RequireAuth><MePage /></RequireAuth>} />
              <Route path="/dashboard" element={<RequireAuth roles={['ngo', 'responder', 'admin']}><Dashboard /></RequireAuth>} />
              <Route path="/org/register" element={<RequireAuth roles={['ngo', 'responder']}><OrgRegister /></RequireAuth>} />
              {/* SOS (women's safety): discreet listening + threat detection -> police alert */}
              <Route path="/sos" element={<RequireAuth><SosPage /></RequireAuth>} />
              <Route path="/admin" element={<RequireAuth roles={['admin']}><Admin /></RequireAuth>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  )
}
