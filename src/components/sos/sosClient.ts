// Small client helpers for SOS mode: chunk uploads, police-org name cache, vibration (SOS never plays sound).
import { ApiError } from '../../lib/api'
import { AUDIO_BUCKET, baseMime, extFromMime } from '../../lib/media'
import type { SosResponse } from '../../lib/sos'
import { supabase } from '../../lib/supabase'
import type { AppNotification } from '../../lib/types'

/** Press-and-hold time for the SOS button and "I'm safe". */
export const SOS_HOLD_MS = 1500

/** Silent feedback only — SOS mode must never make a sound. */
export function vibrate(pattern: number | number[]): void {
  try { navigator.vibrate?.(pattern) } catch { /* unsupported */ }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** `report-audio/<uid>/sos/<session_id>/<seq>.<ext>` (the sos Edge Function checks the prefix). */
export function sosChunkPath(uid: string, sessionId: string, seq: number, mime: string): string {
  return `${uid}/sos/${sessionId}/${seq}.${extFromMime(mime)}`
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { statusCode?: string; status?: number; code?: string; message?: string }
  return e?.statusCode === '409' || e?.status === 409 || e?.code === 'ResourceAlreadyExists' || e?.code === 'Duplicate'
    || /already exists/i.test(e?.message ?? '')
}

/** Upload one SOS audio chunk (one retry). A 409 after a lost response counts as success. */
export async function uploadSosChunk(path: string, blob: Blob, mime: string): Promise<boolean> {
  const contentType = baseMime(mime || blob.type) || 'audio/webm'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabase.storage.from(AUDIO_BUCKET).upload(path, blob, { contentType, upsert: false, cacheControl: '3600' })
      if (!error || isAlreadyExists(error)) return true
    } catch { /* network: retry below */ }
    if (attempt === 0) await sleep(900)
  }
  return false
}

/** 4xx that a retry cannot fix (bad path, ended session…). Network failures / 5xx / 429 are retryable. */
export function isPermanentError(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429
}

// ---- police org names per session (device-local cache, so "My SOS log" can name them later)
const ORGS_KEY = (sessionId: string) => `sos.orgs.${sessionId}`

export function orgNamesOf(res: Pick<SosResponse, 'routed'> | null | undefined): string[] | null {
  if (!res?.routed) return null
  return [...new Set(res.routed.map((r) => r.org_name).filter(Boolean))]
}

export function saveSosOrgs(sessionId: string, names: string[]): void {
  try { localStorage.setItem(ORGS_KEY(sessionId), JSON.stringify(names)) } catch { /* storage unavailable */ }
}

export function readSosOrgs(sessionId: string): string[] | null {
  try {
    const raw = localStorage.getItem(ORGS_KEY(sessionId))
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

/** Police org names carried by a `sos_logged` notification (data.org_names | data.routed[].org_name), if any. */
export function orgNamesFromNotification(n: AppNotification): string[] | null {
  const d = n.data ?? {}
  const names = Array.isArray(d.org_names) ? d.org_names
    : Array.isArray(d.routed) ? (d.routed as unknown[]).map((r) => (r as { org_name?: unknown })?.org_name)
    : null
  if (!names) return null
  const out = names.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return out.length ? out : null
}
