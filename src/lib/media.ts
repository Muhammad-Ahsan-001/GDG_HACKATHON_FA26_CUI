// Client-side media helpers for the report flow: image compression + Supabase Storage uploads.
// Buckets (docs/CONTRACT.md §1): report-audio (private) at `<auth uid>/<client_id>.<ext>`,
// report-images (public) at `<client_id>/<n>.jpg`.
import { supabase } from './supabase'

export const AUDIO_BUCKET = 'report-audio'
export const IMAGE_BUCKET = 'report-images'
export const MAX_PHOTOS = 3
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export type MediaErrorCode = 'decode' | 'too_large' | 'auth' | 'network' | 'upload'

/** Error thrown by the helpers below; `code` tells the UI which friendly message to show. */
export class MediaUploadError extends Error {
  code: MediaErrorCode
  constructor(code: MediaErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'MediaUploadError'
    this.code = code
  }
}

/** Random UUID; falls back to getRandomValues on old WebViews without crypto.randomUUID. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Mime without parameters: 'audio/webm;codecs=opus' -> 'audio/webm'. */
export function baseMime(mime: string): string {
  return (mime || '').split(';')[0].trim().toLowerCase()
}

/** File extension the transcription API understands for a recorder mime type. */
export function extFromMime(mime: string): string {
  const m = baseMime(mime)
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (/mp4|m4a|aac/.test(m)) return 'm4a'
  if (m.includes('wav')) return 'wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('flac')) return 'flac'
  return 'webm'
}

export interface CompressedImage { blob: Blob; width: number; height: number }

type Drawable = { source: CanvasImageSource; width: number; height: number; release: () => void }

async function decodeWithBitmap(file: Blob): Promise<Drawable> {
  // 'from-image' applies the EXIF rotation so phone photos are not sideways.
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() }
}

function decodeWithImg(file: Blob): Promise<Drawable> {
  // Fallback path: <img> can decode formats createImageBitmap rejects on some browsers (e.g. HEIC on Safari).
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve({
      source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url),
    })
    img.onerror = () => { URL.revokeObjectURL(url); reject(new MediaUploadError('decode')) }
    img.src = url
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new MediaUploadError('decode'))), 'image/jpeg', quality)
  })
}

/**
 * Decode any image the browser can read (JPEG/PNG/WebP, HEIC only where the browser supports it),
 * scale so the long edge is <= maxEdge, and re-encode as JPEG. Re-encoding also strips EXIF (incl. GPS).
 * Throws MediaUploadError('decode') when the browser cannot open the file.
 */
export async function compressImage(file: Blob, opts: { maxEdge?: number; quality?: number } = {}): Promise<CompressedImage> {
  const maxEdge = opts.maxEdge ?? 1280
  const quality = opts.quality ?? 0.8
  let d: Drawable
  try {
    d = typeof createImageBitmap === 'function' ? await decodeWithBitmap(file) : await decodeWithImg(file)
  } catch {
    try { d = await decodeWithImg(file) } catch { throw new MediaUploadError('decode') }
  }
  try {
    if (!d.width || !d.height) throw new MediaUploadError('decode')
    const scale = Math.min(1, maxEdge / Math.max(d.width, d.height))
    const width = Math.max(1, Math.round(d.width * scale))
    const height = Math.max(1, Math.round(d.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new MediaUploadError('decode')
    ctx.fillStyle = '#ffffff' // transparent PNGs would otherwise turn black in JPEG
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(d.source, 0, 0, width, height)
    let blob = await canvasToJpeg(canvas, quality)
    if (blob.size > MAX_IMAGE_BYTES) blob = await canvasToJpeg(canvas, 0.6)
    if (blob.size > MAX_IMAGE_BYTES) throw new MediaUploadError('too_large')
    canvas.width = 0 // free the backing store early on low-memory phones
    canvas.height = 0
    return { blob, width, height }
  } finally {
    d.release()
  }
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const uid = data.session?.user.id
  if (!uid) throw new MediaUploadError('auth')
  return uid
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { statusCode?: string; status?: number; code?: string; message?: string }
  return e?.statusCode === '409' || e?.status === 409 || e?.code === 'ResourceAlreadyExists' || e?.code === 'Duplicate'
    || /already exists/i.test(e?.message ?? '')
}

function isNetworkFailure(err: unknown): boolean {
  const e = err as { name?: string; message?: string; originalError?: unknown }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (e?.name === 'StorageUnknownError' || e?.originalError instanceof TypeError) return true
  return /failed to fetch|network|load failed/i.test(e?.message ?? '')
}

/** Upload one object; a retry after a lost response (409 already exists) counts as success. One retry on network errors. */
async function putObject(bucket: string, path: string, body: Blob, contentType: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.storage.from(bucket).upload(path, body, {
      contentType, upsert: false, cacheControl: '3600',
    })
    if (!error || isAlreadyExists(error)) return path
    if (isNetworkFailure(error)) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue }
      throw new MediaUploadError('network', error.message)
    }
    throw new MediaUploadError('upload', error.message)
  }
  throw new MediaUploadError('network')
}

/** Upload a voice note to `report-audio/<uid>/<clientId>.<ext>`; returns the storage path. */
export async function uploadAudio(blob: Blob, mime: string, clientId: string): Promise<string> {
  const uid = await currentUserId()
  const type = baseMime(mime || blob.type) || 'audio/webm'
  return putObject(AUDIO_BUCKET, `${uid}/${clientId}.${extFromMime(type)}`, blob, type)
}

/** Upload compressed JPEGs to `report-images/<clientId>/<n>.jpg` (n = 0..); returns paths in order. */
export async function uploadImages(blobs: Blob[], clientId: string): Promise<string[]> {
  await currentUserId() // insert policy requires an authenticated session
  return Promise.all(blobs.map((b, n) => putObject(IMAGE_BUCKET, `${clientId}/${n}.jpg`, b, 'image/jpeg')))
}
