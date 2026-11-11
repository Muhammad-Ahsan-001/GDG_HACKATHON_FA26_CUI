// Supabase clients + caller authentication for Edge Functions.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.119.0'
import { HttpError } from './http.ts'

export type { SupabaseClient, User }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!

/** New-style keys (sb_publishable_/sb_secret_) are injected as JSON dicts; legacy JWT keys as plain vars. */
function keyFromDict(name: string): string | undefined {
  try {
    const raw = Deno.env.get(name)
    if (!raw) return undefined
    const d = JSON.parse(raw) as Record<string, string>
    return d.default ?? Object.values(d)[0]
  } catch {
    return undefined
  }
}
const LEGACY_ANON = Deno.env.get('SUPABASE_ANON_KEY') || undefined
const LEGACY_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || undefined
const PUBLISHABLE = keyFromDict('SUPABASE_PUBLISHABLE_KEYS')
const SECRET = keyFromDict('SUPABASE_SECRET_KEYS')
const ANON_KEY = (PUBLISHABLE ?? LEGACY_ANON)!
const SERVICE_KEY = (SECRET ?? LEGACY_SERVICE)!
const PUBLIC_KEYS = new Set([PUBLISHABLE, LEGACY_ANON].filter(Boolean) as string[])
const SERVICE_KEYS = new Set([SECRET, LEGACY_SERVICE].filter(Boolean) as string[])

let _admin: SupabaseClient | null = null

/** Service-role client: bypasses RLS. Use only server-side. */
export function adminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return _admin
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null
}

/** Client acting AS the caller (RLS applies, auth.uid() = caller) — use for RPCs that check the caller. */
export function userClient(req: Request): SupabaseClient {
  const token = bearer(req)
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  })
}

/** True when the caller presented the service-role key (internal calls / scripts). */
export function isServiceRequest(req: Request): boolean {
  const token = bearer(req)
  const apikey = req.headers.get('apikey')
  return Boolean((token && SERVICE_KEYS.has(token)) || (apikey && SERVICE_KEYS.has(apikey) && !token?.includes('.')))
}

/** Resolve the calling user (anonymous users included) or throw 401. */
export async function requireUser(req: Request): Promise<User> {
  const token = bearer(req)
  if (!token || PUBLIC_KEYS.has(token) || !token.includes('.')) throw new HttpError(401, 'Sign in required', 'unauthorized')
  const { data, error } = await adminClient().auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Invalid or expired session', 'unauthorized')
  return data.user
}

/** For internal endpoints: allow service-role callers, or any signed-in user. Returns user or null (service). */
export async function requireServiceOrUser(req: Request): Promise<User | null> {
  if (isServiceRequest(req)) return null
  return await requireUser(req)
}
