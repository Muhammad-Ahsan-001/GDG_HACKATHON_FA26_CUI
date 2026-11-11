// POST {text, lang: 'ur'|'en'} -> {url, cached}
// Content-addressed cache: sha256(model|voice|lang|text) -> public bucket `tts-cache/{hash}.mp3` (see _shared/ttsCache.ts).
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { requireUser } from '../_shared/supabase.ts'
import { TtsError, ttsUrl } from '../_shared/ttsCache.ts'

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  await requireUser(req) // anonymous users are fine

  const body = await readJson<{ text?: unknown; lang?: unknown }>(req)
  const raw = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : ''
  if (!raw) throw new HttpError(400, 'text is required', 'empty_text')
  const lang: 'ur' | 'en' = body.lang === 'en' ? 'en' : 'ur'

  try {
    // upload failure still lets the user hear it: an inline data URL plays in <audio> everywhere
    const { url, cached } = await ttsUrl(raw, lang, { inlineOnUploadError: true })
    return json({ url, cached })
  } catch (e) {
    console.error('[tts] speak failed', e instanceof Error ? e.message : e)
    if (e instanceof TtsError) throw new HttpError(502, 'Text-to-speech is unavailable right now', 'tts_failed')
    throw e
  }
})
