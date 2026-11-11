// POST /report-chat — one turn of the AI intake conversation (docs/CONTRACT-1B.md "report-chat").
// Request / response = ReportChatRequest / ReportChatResponse (src/lib/attributes.ts). Stateless: the client keeps
// the conversation and sends it back every turn; nothing is written to the database here.
//
// Pipeline: auth -> (voice) download + transcribe -> silence / no-speech guard (no AI call) -> apply a tapped quick
// reply deterministically -> ONE streamed intakeTurn call -> TTS of the reply starts as soon as the reply is streamed
// -> server rules (turn counter, first-turn urgency chips, ready at MAX_INTAKE_QUESTIONS, emergency => ready).
import {
  applyQuickReply,
  detectNoSpeech,
  type IntakeDraft,
  intakeTurn,
  type IntakeTurnResult,
  type NoSpeechReason,
  type QuickReply,
  transcribe,
  URGENCY_QUICK_REPLIES,
  userUrgencyOf,
} from '../_shared/ai.ts'
import { type AttributeMap, MAX_INTAKE_QUESTIONS, sanitizeAttributes } from '../_shared/attributes.ts'
import { corsHeaders, HttpError, readJson, serve } from '../_shared/http.ts'
import { adminClient, requireUser } from '../_shared/supabase.ts'
import { ttsUrlSafe } from '../_shared/ttsCache.ts'
import { CATEGORIES, type Category, type Lang, URGENCIES, type Urgency } from '../_shared/types.ts'

const MAX_AUDIO_BYTES = 15 * 1024 * 1024
const MAX_HISTORY = 24
const MAX_TEXT = 2000

// Canned replies. NO_SPEECH / TOO_SHORT / NOT_ISSUE are exactly src/lib/voice/prompts.json (noSpeech, tooShort,
// notIssue) so the pre-recorded clips public/voice/<lang>/<id>.mp3 can be played instantly (no AI / TTS call).
const NO_SPEECH = {
  en: 'Sorry, we could not hear you. Please move closer to the mic and try again.',
  ur: 'معاف کیجیے، ہمیں آپ کی آواز سنائی نہیں دی۔ مائیک کے قریب ہو کر دوبارہ بولیں۔',
}
const TOO_SHORT = {
  en: 'That recording was too short. Please tell us a little more about the problem and where it is.',
  ur: 'ریکارڈنگ بہت چھوٹی تھی۔ تھوڑا تفصیل سے بتائیں کہ کیا مسئلہ ہے اور کہاں ہے۔',
}
const NOT_ISSUE = {
  en: 'This does not sound like a local problem. Please tell us what is wrong in your area.',
  ur: 'یہ کسی علاقے کا مسئلہ نہیں لگتا۔ براہِ کرم بتائیں کہ آپ کے محلے میں کیا مسئلہ ہے۔',
}
/** First question (always offered with the 3 urgency chips unless urgency is already known / emergency). */
const URGENCY_QUESTION = {
  en: 'OK, noted. How urgent is it?',
  ur: 'جی، سمجھ گئے۔ یہ کتنا ضروری ہے؟',
}
const CANNED_AI_TEXTS = new Set([NO_SPEECH, TOO_SHORT, NOT_ISSUE].flatMap((c) => [norm(c.en), norm(c.ur)]))

const URGENCY_RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2, critical: 3 }

// ------------------------------------------------------------------------------------------- request

interface Turn { role: 'user' | 'ai'; text: string; text_alt?: string }

interface Body {
  session_id: string
  ui_language: Lang
  history: Turn[]
  attributes: AttributeMap
  audio_path: string | null
  text: string
  quick_reply: { key: string; value: string; label_en?: string; label_ur?: string; icon?: string } | null
  image_paths: string[]
  has_gps: boolean
  /** optional passthrough (not in the contract type): echoed back on no_speech turns */
  draft: IntakeDraft | null
}

function norm(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const safePath = (p: string) => p.length > 2 && p.length < 400 && !p.includes('..') && !p.startsWith('/') && !p.includes('\\')

function validDraft(v: unknown): IntakeDraft | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Record<string, unknown>
  const category = CATEGORIES.includes(d.category as Category) ? d.category as Category : null
  const urgency = URGENCIES.includes(d.urgency as Urgency) ? d.urgency as Urgency : null
  if (!category || !urgency) return null
  return {
    category,
    urgency,
    title_en: str(d.title_en, 200),
    title_ur: str(d.title_ur, 200),
    summary_en: str(d.summary_en, 600),
    summary_ur: str(d.summary_ur, 600),
  }
}

function validate(raw: unknown, userId: string): Body {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Body must be a JSON object', 'bad_request')
  const b = raw as Record<string, unknown>
  const session_id = str(b.session_id, 100)
  if (!session_id) throw new HttpError(400, 'session_id is required', 'bad_request')

  const history: Turn[] = Array.isArray(b.history)
    ? b.history.flatMap((t): Turn[] => {
      if (!t || typeof t !== 'object') return []
      const r = t as Record<string, unknown>
      const role = r.role === 'ai' ? 'ai' : r.role === 'user' ? 'user' : null
      const text = str(r.text, 1000)
      if (!role) return []
      return [{ role, text, ...(typeof r.text_alt === 'string' ? { text_alt: str(r.text_alt, 1000) } : {}) }]
    }).slice(-MAX_HISTORY)
    : []

  const audio_path = str(b.audio_path, 400) || null
  if (audio_path) {
    if (!safePath(audio_path)) throw new HttpError(400, 'Invalid audio_path', 'bad_request')
    // report-audio is private: a caller may only use audio from their own folder ({auth.uid()}/...)
    if (!audio_path.startsWith(`${userId}/`)) throw new HttpError(403, 'audio_path must be inside your own folder', 'forbidden')
  }

  let quick_reply: Body['quick_reply'] = null
  if (b.quick_reply && typeof b.quick_reply === 'object') {
    const q = b.quick_reply as Record<string, unknown>
    const key = str(q.key, 60)
    const value = str(q.value, 60)
    if (key && value) {
      quick_reply = {
        key,
        value,
        ...(typeof q.label_en === 'string' ? { label_en: str(q.label_en, 60) } : {}),
        ...(typeof q.label_ur === 'string' ? { label_ur: str(q.label_ur, 60) } : {}),
        ...(typeof q.icon === 'string' ? { icon: str(q.icon, 40) } : {}),
      }
    }
  }

  const image_paths = Array.isArray(b.image_paths)
    ? [...new Set(b.image_paths.map((p) => str(p, 400)).filter((p) => p && safePath(p)))].slice(0, 5)
    : []
  const lat = Number(b.lat)
  const lng = Number(b.lng)
  return {
    session_id,
    ui_language: b.ui_language === 'en' ? 'en' : 'ur',
    history,
    attributes: sanitizeAttributes(b.attributes),
    audio_path,
    text: str(b.text, MAX_TEXT),
    quick_reply,
    image_paths,
    has_gps: Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0),
    draft: validDraft(b.draft),
  }
}

// ------------------------------------------------------------------------------------------- helpers

function audioMime(path: string, blobType: string): string {
  if (blobType && /^(audio|video)\//.test(blobType)) return blobType.split(';')[0]
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    aac: 'audio/aac', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
  }
  return map[ext] ?? 'audio/webm'
}

async function transcribeTurn(path: string, lang: Lang): Promise<string> {
  const { data: blob, error } = await adminClient().storage.from('report-audio').download(path)
  if (error || !blob) throw new HttpError(404, 'Recording not found', 'audio_not_found')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!bytes.byteLength) return ''
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, 'Recording is too long', 'audio_too_large')
  try {
    return (await transcribe(bytes, audioMime(path, blob.type), lang)).text
  } catch (e) {
    console.error('[report-chat] transcribe failed:', e instanceof Error ? e.message : e)
    throw new HttpError(502, 'Could not process the recording right now. Please try again.', 'stt_failed')
  }
}

/** AI questions already asked = AI turns in the history, not counting the canned "could not hear you" replies. */
function countQuestions(history: Turn[]): number {
  return history.filter((t) => t.role === 'ai' && !CANNED_AI_TEXTS.has(norm(t.text)) && !CANNED_AI_TEXTS.has(norm(t.text_alt ?? ''))).length
}

function placeholderDraft(attrs: AttributeMap): IntakeDraft {
  const u = userUrgencyOf(attrs)
  return {
    category: 'other',
    urgency: u === 'emergency' ? 'critical' : u === 'urgent' ? 'high' : u === 'can_wait' ? 'low' : 'medium',
    title_en: '',
    title_ur: '',
    summary_en: '',
    summary_ur: '',
  }
}

function stripEnd(s: string): string {
  return norm(s).replace(/[\s.!?؟۔،,:;]+$/u, '')
}

function confirmation(draft: IntakeDraft, emergency: boolean): { en: string; ur: string } {
  const en = stripEnd(draft.title_en) || 'Your report'
  const ur = stripEnd(draft.title_ur) || 'آپ کی رپورٹ'
  return emergency
    ? { en: `${en}. Sending help now.`, ur: `${ur}۔ ابھی مدد کے لیے بھیج رہے ہیں۔` }
    : { en: `${en}. Sending now?`, ur: `${ur}۔ ابھی بھیج دیں؟` }
}

function respond(data: unknown, timings: Record<string, number>): Response {
  const serverTiming = Object.entries(timings).map(([k, v]) => `${k};dur=${Math.round(v)}`).join(', ')
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Server-Timing': serverTiming,
      'Access-Control-Expose-Headers': 'Server-Timing',
    },
  })
}

// ------------------------------------------------------------------------------------------- handler

serve(async (req) => {
  const t0 = Date.now()
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireUser(req) // anonymous users are fine
  const body = validate(await readJson<unknown>(req), user.id)
  const lang = body.ui_language
  const timings: Record<string, number> = {}

  const questionsAsked = countQuestions(body.history)
  const priorContent = body.history.some((t) => t.role === 'user' && !detectNoSpeech(t.text, { minWords: 1 }).no_speech)

  // ---- 1. this turn's words
  let transcript: string | undefined
  if (body.audio_path) {
    const ts = Date.now()
    transcript = await transcribeTurn(body.audio_path, lang)
    timings.stt = Date.now() - ts
  }
  const words = norm(transcript ?? body.text)
  const hasWordsInput = Boolean(body.audio_path) || Boolean(body.text)
  const photoOnly = !hasWordsInput && !body.quick_reply && body.image_paths.length > 0

  // drop a duplicate of this very turn if the client already appended it to the history
  const last = body.history.at(-1)
  const history = last && last.role === 'user' && words && norm(last.text) === words ? body.history.slice(0, -1) : body.history

  // ---- 2. silence / no-speech: never call the AI, never count a turn
  const noSpeech = (reason: NoSpeechReason, msg = reason === 'too_short' ? TOO_SHORT : NO_SPEECH, clip = reason === 'too_short' ? 'tooShort' : 'noSpeech') => {
    timings.total = Date.now() - t0
    console.log(`[report-chat] ${body.session_id} no_speech (${reason}) turn=${questionsAsked}`, JSON.stringify(timings))
    return respond({
      turn: questionsAsked,
      ...(transcript !== undefined ? { transcript } : {}),
      no_speech: true,
      reply: msg,
      reply_audio_url: `/voice/${lang}/${clip}.mp3`, // pre-recorded app clip (same text), plays instantly
      quick_replies: [],
      attributes: body.attributes,
      draft: body.draft ?? placeholderDraft(body.attributes),
      ready: false,
      emergency: false,
      ask_photo: false,
    }, timings)
  }
  if (!body.quick_reply && !photoOnly) {
    const check = detectNoSpeech(words, { minWords: questionsAsked === 0 && !priorContent ? 2 : 1 })
    if (check.no_speech) return noSpeech(check.reason ?? 'empty')
  }

  // ---- 3. tapped chip -> attributes (deterministic, source 'user') BEFORE the AI call
  let attrs = body.attributes
  if (body.quick_reply) attrs = applyQuickReply(attrs, body.quick_reply)
  const askUrgency = questionsAsked === 0 && !userUrgencyOf(attrs)
  const noQuestionsLeft = questionsAsked >= MAX_INTAKE_QUESTIONS

  // the canned first question's clip is (almost always) cached: look it up in parallel with the AI call
  const urgencyClip = askUrgency ? ttsUrlSafe(URGENCY_QUESTION[lang], lang) : null

  // ---- 4. ONE AI call; TTS starts as soon as the reply has been streamed (if the server is going to keep it)
  const early: { text?: string; audio?: Promise<string | undefined> } = {}
  const ta = Date.now()
  let ai: IntakeTurnResult
  try {
    const r = await intakeTurn({
      uiLanguage: lang,
      history: history.map((t) => ({ role: t.role, text: t.text })),
      attributes: attrs,
      turnKind: body.quick_reply ? 'quick_reply' : body.audio_path ? 'voice' : photoOnly ? 'photo' : 'text',
      turnText: words,
      quickReply: body.quick_reply ? { key: body.quick_reply.key, value: body.quick_reply.value } : null,
      questionsAsked,
      askUrgency,
      hasImage: body.image_paths.length > 0,
      hasGps: body.has_gps,
    }, {
      onReply: (e) => {
        if (early.audio) return
        timings.ai_reply = Date.now() - ta
        const replaced = e.off_topic || (askUrgency && !e.emergency) || (noQuestionsLeft && !e.ready && !e.emergency)
        if (replaced) return
        early.text = e[lang]
        early.audio = ttsUrlSafe(e[lang], lang)
      },
    })
    ai = r.data
    timings.ai = Date.now() - ta
  } catch (e) {
    console.error('[report-chat] intake failed:', e instanceof Error ? e.message : e)
    throw new HttpError(502, 'The assistant is unavailable right now. Please try again or send the report as it is.', 'ai_failed')
  }

  // ---- 5. server rules
  if (ai.off_topic && !priorContent && !body.quick_reply && questionsAsked === 0) return noSpeech('empty', NOT_ISSUE, 'notIssue')

  const emergency = ai.emergency || userUrgencyOf(ai.attributes) === 'emergency'
  let ready = ai.ready || emergency || noQuestionsLeft
  let reply = { en: ai.reply_en, ur: ai.reply_ur }
  let quick_replies: QuickReply[] = ai.quick_replies
  const draft: IntakeDraft = { ...ai.draft }
  if (emergency && URGENCY_RANK[draft.urgency] < URGENCY_RANK.high) draft.urgency = 'high'

  if (askUrgency && !emergency) {
    // first question: always the 3 user-urgency chips
    ready = false
    reply = URGENCY_QUESTION
    quick_replies = URGENCY_QUICK_REPLIES
  } else if (ready) {
    quick_replies = []
    if (!ai.ready && !ai.emergency) reply = confirmation(draft, emergency) // forced ready: the model's text was a question
    else if (emergency && !ai.emergency && !/مدد|help/i.test(reply.en + reply.ur)) reply = confirmation(draft, true)
  }
  const turn = Math.min(MAX_INTAKE_QUESTIONS, questionsAsked + (ready ? 0 : 1))

  // ---- 6. reply audio in the UI language (never fails the turn)
  const tt = Date.now()
  const spoken = reply[lang]
  let reply_audio_url: string | undefined
  if (early.audio && norm(early.text ?? '') === norm(spoken)) reply_audio_url = await early.audio
  else if (urgencyClip && spoken === URGENCY_QUESTION[lang]) reply_audio_url = await urgencyClip
  else reply_audio_url = await ttsUrlSafe(spoken, lang)
  timings.tts_wait = Date.now() - tt
  timings.total = Date.now() - t0

  console.log(
    `[report-chat] ${body.session_id} turn=${turn} ready=${ready} emergency=${emergency} attrs=${Object.keys(ai.attributes).length}`,
    JSON.stringify(timings),
  )
  return respond({
    turn,
    ...(transcript !== undefined ? { transcript } : {}),
    no_speech: false,
    reply,
    ...(reply_audio_url ? { reply_audio_url } : {}),
    quick_replies,
    attributes: ai.attributes,
    draft,
    ready,
    emergency,
    ask_photo: emergency ? false : ai.ask_photo,
  }, timings)
})
