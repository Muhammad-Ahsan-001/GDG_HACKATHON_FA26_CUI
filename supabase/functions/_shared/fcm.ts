// Firebase Cloud Messaging (HTTP v1) push sender.
// Auth: service-account JSON (env FIREBASE_SERVICE_ACCOUNT_JSON, whole JSON as a string) -> RS256 JWT signed with
// WebCrypto (no npm dependency, so bundling never depends on node_modules) -> OAuth2 access token (cached ~55 min).
// Without the env var every call is a logged no-op returning 0, so the app keeps working without Firebase
// (notifications rows + realtime still deliver in-app).
import { APP_URL } from './config.ts'
import { adminClient } from './supabase.ts'

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TOKEN_AUD = 'https://oauth2.googleapis.com/token'
const SEND_CONCURRENCY = 8
const SEND_TIMEOUT_MS = 8000

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  private_key_id?: string
  token_uri?: string
}

export interface PushPayload {
  title: string
  body: string
  /** extra data fields (stringified); `type`, `cluster_id`, `url` are always present */
  data?: Record<string, string | number | boolean | null | undefined>
  /** app-relative path, e.g. "/pin/<cluster_id>" — becomes data.url and webpush.fcm_options.link (APP_URL + link) */
  link?: string
  type?: string
  cluster_id?: string
}

let warnedMissing = false
let account: ServiceAccount | null | undefined
let cachedToken: { token: string; expiresAt: number } | null = null
let signingKey: CryptoKey | null = null

function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account
  const raw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON')?.trim()
  if (!raw) {
    account = null
    return null
  }
  try {
    const parsed = JSON.parse(raw) as ServiceAccount
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) throw new Error('missing fields')
    // secrets set from a shell sometimes keep literal "\n" inside the key
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
    account = parsed
  } catch (e) {
    console.error('[fcm] FIREBASE_SERVICE_ACCOUNT_JSON is not valid service-account JSON:', e instanceof Error ? e.message : e)
    account = null
  }
  return account
}

/** True when push is configured (service account present and parseable). */
export function fcmEnabled(): boolean {
  return serviceAccount() !== null
}

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, '')
  const bin = atob(b64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

/** RS256 JWT assertion for the Google OAuth2 JWT-bearer grant. */
async function signAssertion(sa: ServiceAccount, aud: string): Promise<string> {
  if (!signingKey) signingKey = await importPrivateKey(sa.private_key)
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }))
  const claims = b64url(JSON.stringify({ iss: sa.client_email, sub: sa.client_email, aud, scope: SCOPE, iat: now, exp: now + 3600 }))
  const input = `${header}.${claims}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token
  const aud = sa.token_uri || TOKEN_AUD
  const assertion = await signAssertion(sa, aud)
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`[fcm] oauth token http ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = await res.json() as { access_token: string; expires_in?: number }
  // cache ~55 min (or 5 min less than Google's expiry)
  const ttl = Math.min(55 * 60, Math.max(60, (body.expires_in ?? 3600) - 300))
  cachedToken = { token: body.access_token, expiresAt: Date.now() + ttl * 1000 }
  return body.access_token
}

function buildMessage(token: string, p: PushPayload) {
  const url = p.link ?? (p.cluster_id ? `/pin/${p.cluster_id}` : '/map')
  const data: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.data ?? {})) if (v !== undefined && v !== null) data[k] = String(v)
  data.type = p.type ?? data.type ?? 'notification'
  data.cluster_id = p.cluster_id ?? data.cluster_id ?? ''
  data.url = url
  const link = /^https?:\/\//.test(url) ? url : `${APP_URL.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`
  return {
    message: {
      token,
      notification: { title: p.title, body: p.body },
      data,
      webpush: {
        // FCM rejects the whole message when fcm_options.link is not HTTPS (e.g. APP_URL unset -> localhost);
        // the service worker opens data.url on click anyway.
        ...(link.startsWith('https://') ? { fcm_options: { link } } : {}),
        notification: {
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          tag: data.cluster_id || data.type,
          renotify: true,
        },
      },
    },
  }
}

type SendOutcome = 'ok' | 'invalid_token' | 'error'

async function sendOne(sa: ServiceAccount, bearer: string, token: string, p: PushPayload): Promise<SendOutcome> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMessage(token, p)),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  if (res.ok) {
    await res.body?.cancel()
    return 'ok'
  }
  const text = await res.text()
  let status = ''
  let message = ''
  const codes: string[] = []
  try {
    const err = (JSON.parse(text) as {
      error?: { status?: string; message?: string; details?: { errorCode?: string }[] }
    }).error
    status = err?.status ?? ''
    message = err?.message ?? ''
    for (const d of err?.details ?? []) if (d.errorCode) codes.push(d.errorCode)
  } catch { /* not json */ }
  const tokenProblem = res.status === 404 || status === 'NOT_FOUND' || codes.includes('UNREGISTERED') ||
    ((status === 'INVALID_ARGUMENT' || codes.includes('INVALID_ARGUMENT')) && /registration token|token/i.test(message))
  if (tokenProblem) return 'invalid_token'
  if (res.status === 401) cachedToken = null // force a fresh OAuth token next time
  console.warn('[fcm] send failed', res.status, status, codes.join(','), message.slice(0, 200))
  return 'error'
}

/**
 * Send the same notification to many FCM registration tokens. Returns the number delivered to FCM.
 * Dead tokens (404 / UNREGISTERED / INVALID_ARGUMENT for the token) are deleted from device_tokens.
 * Never throws.
 */
export async function sendToTokens(tokens: string[], payload: PushPayload): Promise<number> {
  const unique = [...new Set(tokens.filter((t) => typeof t === 'string' && t.length > 10))]
  if (!unique.length) return 0
  const sa = serviceAccount()
  if (!sa) {
    if (!warnedMissing) {
      console.log('[fcm] FIREBASE_SERVICE_ACCOUNT_JSON not set — push disabled (in-app notifications still work)')
      warnedMissing = true
    }
    return 0
  }
  let bearer: string
  try {
    bearer = await accessToken(sa)
  } catch (e) {
    console.error('[fcm] could not obtain access token:', e instanceof Error ? e.message : e)
    return 0
  }
  let sent = 0
  const dead: string[] = []
  for (let i = 0; i < unique.length; i += SEND_CONCURRENCY) {
    const batch = unique.slice(i, i + SEND_CONCURRENCY)
    const results = await Promise.all(batch.map((t) =>
      sendOne(sa, bearer, t, payload).catch((e) => {
        console.warn('[fcm] send error', e instanceof Error ? e.message : e)
        return 'error' as SendOutcome
      })
    ))
    results.forEach((r, j) => {
      if (r === 'ok') sent++
      else if (r === 'invalid_token') dead.push(batch[j])
    })
  }
  if (dead.length) {
    const { error } = await adminClient().from('device_tokens').delete().in('fcm_token', dead)
    if (error) console.warn('[fcm] could not delete dead tokens', error.message)
    else console.log(`[fcm] removed ${dead.length} dead token(s)`)
  }
  console.log(`[fcm] sent ${sent}/${unique.length} type=${payload.type ?? ''} cluster=${payload.cluster_id ?? ''}`)
  return sent
}
