// Content-addressed TTS cache shared by the `tts` endpoint, report-chat and voice-profile.
// sha256(model|voice|lang|text) -> public bucket `tts-cache/{hash}.mp3` (docs/CONTRACT.md §1 storage, §2 tts).
import { speak, ttsVoiceFor } from './ai.ts'
import { MODELS } from './models.ts'
import { adminClient } from './supabase.ts'

export const TTS_BUCKET = 'tts-cache'
export const TTS_MAX_CHARS = 1500

export type TtsLang = 'ur' | 'en'

export interface TtsResult {
  /** public https URL (or a data: URL when the upload failed and inlineOnUploadError was set) */
  url: string
  cached: boolean
  ms: number
}

/** Thrown when speech synthesis itself failed (both TTS models). */
export class TtsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TtsError'
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Collapse whitespace and trim to TTS_MAX_CHARS, preferring to cut at a sentence or word boundary. */
export function clipTtsText(raw: string): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= TTS_MAX_CHARS) return text
  const head = text.slice(0, TTS_MAX_CHARS)
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('۔'), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('؟'))
  if (sentenceEnd > TTS_MAX_CHARS * 0.6) return head.slice(0, sentenceEnd + 1).trim()
  const space = head.lastIndexOf(' ')
  return (space > TTS_MAX_CHARS * 0.6 ? head.slice(0, space) : head).trim()
}

/** Storage path for a clip (text must already be clipped with clipTtsText). */
export async function ttsCacheKey(model: string, lang: TtsLang, text: string): Promise<string> {
  return `${await sha256Hex(`${model}|${ttsVoiceFor(model)}|${lang}|${text}`)}.mp3`
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function exists(path: string): Promise<boolean> {
  try {
    const { data } = await adminClient().storage.from(TTS_BUCKET).exists(path)
    return data === true
  } catch {
    return false
  }
}

/**
 * Public URL of the spoken `text` in `lang`, generating + caching it on a miss.
 * Prefers a clip made by the primary TTS model, then one made earlier by the fallback model.
 * Throws TtsError when synthesis fails; when the upload fails it throws too unless `inlineOnUploadError`
 * (then a data: URL is returned so the caller can still play it).
 */
export async function ttsUrl(text: string, lang: TtsLang, opts: { inlineOnUploadError?: boolean } = {}): Promise<TtsResult> {
  const t0 = Date.now()
  const clipped = clipTtsText(text)
  if (!clipped) throw new TtsError('empty text')
  const storage = adminClient().storage.from(TTS_BUCKET)
  const [primaryPath, fallbackPath] = await Promise.all([
    ttsCacheKey(MODELS.tts.primary, lang, clipped),
    ttsCacheKey(MODELS.tts.fallback, lang, clipped),
  ])

  const [hasPrimary, hasFallback] = await Promise.all([exists(primaryPath), exists(fallbackPath)])
  const hit = hasPrimary ? primaryPath : hasFallback ? fallbackPath : null
  if (hit) return { url: storage.getPublicUrl(hit).data.publicUrl, cached: true, ms: Date.now() - t0 }

  let audio: Awaited<ReturnType<typeof speak>>
  try {
    audio = await speak(clipped, lang)
  } catch (e) {
    throw new TtsError(e instanceof Error ? e.message : String(e))
  }

  const path = audio.model === MODELS.tts.primary ? primaryPath : await ttsCacheKey(audio.model, lang, clipped)
  const { error } = await storage.upload(path, new Blob([new Uint8Array(audio.audio)], { type: audio.mime }), {
    contentType: audio.mime,
    upsert: true,
    cacheControl: '31536000',
  })
  if (error) {
    console.error('[tts-cache] upload failed', error.message)
    if (opts.inlineOnUploadError) return { url: `data:${audio.mime};base64,${toBase64(audio.audio)}`, cached: false, ms: Date.now() - t0 }
    throw new TtsError(`upload failed: ${error.message}`)
  }
  return { url: storage.getPublicUrl(path).data.publicUrl, cached: false, ms: Date.now() - t0 }
}

/** Like ttsUrl but never throws: undefined when anything failed (callers then show text only). */
export async function ttsUrlSafe(text: string, lang: TtsLang): Promise<string | undefined> {
  try {
    return (await ttsUrl(text, lang)).url
  } catch (e) {
    console.warn('[tts-cache] no audio:', e instanceof Error ? e.message : e)
    return undefined
  }
}
