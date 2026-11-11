// Supabase clients + caller authentication for Edge Functions.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.119.0'
import { HttpError } from './http.ts'

export type { SupabaseClient, User }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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
  const secret = Deno.env.get('SUPABASE_SECRET_KEY')
  return Boolean(token && (token === SERVICE_KEY || (secret && token === secret)))
}

/** Resolve the calling user (anonymous users included) or throw 401. */
export async function requireUser(req: Request): Promise<User> {
  const token = bearer(req)
  if (!token || token === ANON_KEY) throw new HttpError(401, 'Sign in required', 'unauthorized')
  const { data, error } = await adminClient().auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Invalid or expired session', 'unauthorized')
  return data.user
}

/** For internal endpoints: allow service-role callers, or any signed-in user. Returns user or null (service). */
export async function requireServiceOrUser(req: Request): Promise<User | null> {
  if (isServiceRequest(req)) return null
  return await requireUser(req)
}
