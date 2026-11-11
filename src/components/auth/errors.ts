// Turns Supabase Auth / PostgREST / Edge Function errors into a friendly i18n key (+ the raw detail for debugging).

export interface FriendlyError { key: string; detail: string }

function readField(e: unknown, field: string): string {
  if (e && typeof e === 'object' && field in e) {
    const v = (e as Record<string, unknown>)[field]
    if (typeof v === 'string' || typeof v === 'number') return String(v)
  }
  return ''
}

export function friendlyError(e: unknown): FriendlyError {
  const message = e instanceof Error ? e.message : readField(e, 'message') || String(e ?? '')
  const code = readField(e, 'code').toLowerCase()
  const name = readField(e, 'name')
  const status = Number(readField(e, 'status')) || 0
  const m = message.toLowerCase()
  const has = (...needles: string[]) => needles.some((n) => code === n || m.includes(n))

  let key = 'auth.err_generic'
  if (has('invalid_credentials', 'invalid login credentials')) key = 'auth.err_invalidCredentials'
  else if (has('email_not_confirmed', 'email not confirmed')) key = 'auth.err_emailNotConfirmed'
  else if (has('user_already_exists', 'email_exists', 'already registered', 'already been registered')) key = 'auth.err_userExists'
  else if (has('weak_password', 'password should be', 'password is too')) key = 'auth.err_weakPassword'
  else if (has('anonymous_provider_disabled', 'anonymous sign-ins are disabled')) key = 'auth.err_anonDisabled'
  else if (has('signup_disabled', 'signups not allowed')) key = 'auth.err_signupDisabled'
  else if (has('over_request_rate_limit', 'over_email_send_rate_limit', 'rate limit') || status === 429) key = 'auth.err_rateLimit'
  else if (has('email_address_invalid', 'invalid email', 'unable to validate email')) key = 'auth.needEmail'
  else if (
    name === 'AuthRetryableFetchError' || m.includes('failed to fetch') || m.includes('networkerror') ||
    m.includes('network request failed') || m.includes('load failed') ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) key = 'auth.err_network'
  else if (code === '42501' || status === 403 || has('not allowed', 'forbidden', 'permission denied', 'not_admin')) key = 'auth.err_notAllowed'

  return { key, detail: message }
}
