// POST /voice-profile — onboarding "tell us your name and your area" (docs/CONTRACT-1B.md "voice-profile").
// { audio_path?: string; text?: string; ui_language: 'ur'|'en' }
//   -> { transcript, no_speech, profile: { display_name, home_area, language }, confirm: { en, ur }, confirm_audio_url? }
// Nothing is saved here: the client shows the read-back card and saves with the complete_onboarding RPC.
import { detectNoSpeech, extractProfile, type ProfileExtraction, transcribe } from '../_shared/ai.ts'
import { corsHeaders, HttpError, readJson, serve } from '../_shared/http.ts'
import { adminClient, requireUser } from '../_shared/supabase.ts'
import { ttsUrlSafe } from '../_shared/ttsCache.ts'
import type { Lang } from '../_shared/types.ts'

const MAX_AUDIO_BYTES = 10 * 1024 * 1024

const NOT_HEARD = {
  en: 'Sorry, we could not hear you. Please press the mic and tell us your name and your area again.',
  ur: 'معاف کیجیے، ہمیں آپ کی آواز سنائی نہیں دی۔ مائیک دبائیں اور اپنا نام اور علاقہ دوبارہ بتائیں۔',
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const safePath = (p: string) => p.length > 2 && p.length < 400 && !p.includes('..') && !p.startsWith('/') && !p.includes('\\')

function audioMime(path: string, blobType: string): string {
  if (blobType && /^(audio|video)\//.test(blobType)) return blobType.split(';')[0]
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    aac: 'audio/aac', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
  }
  return map[ext] ?? 'audio/webm'
}

/** Read-back sentence. Urdu avoids gendered verbs ("آپ کا علاقہ … ہے" instead of رہتے / رہتی ہیں). */
function confirmText(p: ProfileExtraction): { en: string; ur: string } {
  const name = p.display_name
  const area = p.home_area
  const nameUr = p.display_name_ur ?? name
  const areaUr = p.home_area_ur ?? area
  if (name && area) {
    return {
      en: `Your name is ${name} and you live in ${area}. Is that right?`,
      ur: `آپ کا نام ${nameUr} ہے اور آپ کا علاقہ ${areaUr} ہے۔ کیا یہ درست ہے؟`,
    }
  }
  if (name) {
    return {
      en: `Your name is ${name}. We did not catch your area. Please tell us your area too.`,
      ur: `آپ کا نام ${nameUr} ہے۔ ہمیں آپ کا علاقہ سمجھ نہیں آیا، براہِ کرم اپنا علاقہ بھی بتائیں۔`,
    }
  }
  if (area) {
    return {
      en: `You live in ${area}. We did not catch your name. Please tell us your name too.`,
      ur: `آپ کا علاقہ ${areaUr} ہے۔ ہمیں آپ کا نام سمجھ نہیں آیا، براہِ کرم اپنا نام بھی بتائیں۔`,
    }
  }
  return {
    en: 'Sorry, we could not catch your name and area. Please say them again, for example: My name is Ayesha and I live in G-9.',
    ur: 'معاف کیجیے، ہمیں آپ کا نام اور علاقہ سمجھ نہیں آیا۔ دوبارہ بتائیں، مثلاً: میرا نام عائشہ ہے اور میں جی نائن میں رہتی ہوں۔',
  }
}

function respond(data: unknown, timings: Record<string, number>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Server-Timing': Object.entries(timings).map(([k, v]) => `${k};dur=${Math.round(v)}`).join(', '),
      'Access-Control-Expose-Headers': 'Server-Timing',
    },
  })
}

serve(async (req) => {
  const t0 = Date.now()
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireUser(req) // anonymous users are fine (onboarding signs in anonymously first)
  const raw = await readJson<Record<string, unknown>>(req)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Body must be a JSON object', 'bad_request')
  const lang: Lang = raw.ui_language === 'en' ? 'en' : 'ur'
  const audio_path = str(raw.audio_path, 400)
  const text = str(raw.text, 1000)
  if (!audio_path && !text && raw.text === undefined) throw new HttpError(400, 'Send audio_path or text', 'bad_request')
  const timings: Record<string, number> = {}

  // ---- 1. what was said
  let said = text
  if (audio_path) {
    if (!safePath(audio_path)) throw new HttpError(400, 'Invalid audio_path', 'bad_request')
    if (!audio_path.startsWith(`${user.id}/`)) throw new HttpError(403, 'audio_path must be inside your own folder', 'forbidden')
    const ts = Date.now()
    const { data: blob, error } = await adminClient().storage.from('report-audio').download(audio_path)
    if (error || !blob) throw new HttpError(404, 'Recording not found', 'audio_not_found')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, 'Recording is too long', 'audio_too_large')
    said = ''
    if (bytes.byteLength) {
      try {
        said = (await transcribe(bytes, audioMime(audio_path, blob.type), lang)).text
      } catch (e) {
        console.error('[voice-profile] transcribe failed:', e instanceof Error ? e.message : e)
        throw new HttpError(502, 'Could not process the recording right now. Please try again.', 'stt_failed')
      }
    }
    timings.stt = Date.now() - ts
  }
  const transcript = said.replace(/\s+/g, ' ').trim()

  // ---- 2. silence -> ask again (no AI extraction)
  if (detectNoSpeech(transcript, { minWords: 1 }).no_speech) {
    const tt = Date.now()
    const confirm_audio_url = await ttsUrlSafe(NOT_HEARD[lang], lang)
    timings.tts = Date.now() - tt
    timings.total = Date.now() - t0
    return respond({
      transcript,
      no_speech: true,
      profile: { display_name: null, home_area: null, language: null },
      confirm: NOT_HEARD,
      ...(confirm_audio_url ? { confirm_audio_url } : {}),
    }, timings)
  }

  // ---- 3. extract + read-back clip
  const ta = Date.now()
  let profile: ProfileExtraction
  try {
    profile = (await extractProfile(transcript, { uiLanguage: lang })).data
  } catch (e) {
    console.error('[voice-profile] extract failed:', e instanceof Error ? e.message : e)
    throw new HttpError(502, 'Could not understand that right now. Please try again or type instead.', 'ai_failed')
  }
  timings.ai = Date.now() - ta
  const confirm = confirmText(profile)
  const tt = Date.now()
  const confirm_audio_url = await ttsUrlSafe(confirm[lang], lang)
  timings.tts = Date.now() - tt
  timings.total = Date.now() - t0
  console.log('[voice-profile]', JSON.stringify(timings), `name=${profile.display_name ? 'yes' : 'no'} area=${profile.home_area ? 'yes' : 'no'}`)

  return respond({
    transcript,
    no_speech: false,
    profile: { display_name: profile.display_name, home_area: profile.home_area, language: profile.language },
    confirm,
    ...(confirm_audio_url ? { confirm_audio_url } : {}),
  }, timings)
})
