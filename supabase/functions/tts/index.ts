// POST {text, lang: 'ur'|'en'} -> {url, cached}
// Content-addressed cache: sha256(model|voice|lang|text) -> public bucket `tts-cache/{hash}.mp3`.
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { adminClient, requireUser } from '../_shared/supabase.ts'
import { speak, ttsVoiceFor } from '../_shared/ai.ts'
import { MODELS } from '../_shared/models.ts'

const BUCKET = 'tts-cache'
const MAX_CHARS = 1500

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Trim to MAX_CHARS, preferring to cut at a sentence or word boundary. */
function clip(text: string): string {
  if (text.length <= MAX_CHARS) return text
  const head = text.slice(0, MAX_CHARS)
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('۔'), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('؟'))
  if (sentenceEnd > MAX_CHARS * 0.6) return head.slice(0, sentenceEnd + 1).trim()
  const space = head.lastIndexOf(' ')
  return (space > MAX_CHARS * 0.6 ? head.slice(0, space) : head).trim()
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function cacheKey(model: string, lang: string, text: string): Promise<string> {
  return `${await sha256Hex(`${model}|${ttsVoiceFor(model)}|${lang}|${text}`)}.mp3`
}

async function exists(path: string): Promise<boolean> {
  try {
    const { data } = await adminClient().storage.from(BUCKET).exists(path)
    return data === true
  } catch {
    return false
  }
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  await requireUser(req) // anonymous users are fine

  const body = await readJson<{ text?: unknown; lang?: unknown }>(req)
  const raw = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : ''
  if (!raw) throw new HttpError(400, 'text is required', 'empty_text')
  const text = clip(raw)
  const lang: 'ur' | 'en' = body.lang === 'en' ? 'en' : 'ur'

  const storage = adminClient().storage.from(BUCKET)
  const primaryPath = await cacheKey(MODELS.tts.primary, lang, text)
  const fallbackPath = await cacheKey(MODELS.tts.fallback, lang, text)

  // Prefer the primary model's audio; fall back to audio produced earlier by the fallback model.
  const [hasPrimary, hasFallback] = await Promise.all([exists(primaryPath), exists(fallbackPath)])
  const hit = hasPrimary ? primaryPath : hasFallback ? fallbackPath : null
  if (hit) return json({ url: storage.getPublicUrl(hit).data.publicUrl, cached: true })

  let audio: Awaited<ReturnType<typeof speak>>
  try {
    audio = await speak(text, lang)
  } catch (e) {
    console.error('[tts] speak failed', e instanceof Error ? e.message : e)
    throw new HttpError(502, 'Text-to-speech is unavailable right now', 'tts_failed')
  }

  const path = audio.model === MODELS.tts.primary ? primaryPath : await cacheKey(audio.model, lang, text)
  const { error } = await storage.upload(path, new Blob([new Uint8Array(audio.audio)], { type: audio.mime }), {
    contentType: audio.mime,
    upsert: true,
    cacheControl: '31536000',
  })
  if (error) {
    // Still let the user hear it: an inline data URL plays in <audio> everywhere.
    console.error('[tts] upload failed', error.message)
    return json({ url: `data:${audio.mime};base64,${toBase64(audio.audio)}`, cached: false })
  }
  return json({ url: storage.getPublicUrl(path).data.publicUrl, cached: false })
})
