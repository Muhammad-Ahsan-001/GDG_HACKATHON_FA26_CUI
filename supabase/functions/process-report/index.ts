// POST /process-report — the core pipeline: voice / photo / text -> AI extraction -> location -> duplicate
// clustering -> verification -> responder routing -> nearby alerts. See docs/CONTRACT.md §2 "process-report".
// Phase 1b (docs/CONTRACT-1B.md): also accepts the AI intake conversation (no re-transcription), attributes,
// the citizen's own urgency choice, the intake session id and every voice turn (audio_paths). Silence -> 200 rejected.
import { checkPhoto, detectNoSpeech, embed, extractReport, sameIncident, transcribe } from '../_shared/ai.ts'
import { type AttributeMap, type ReportAttribute, sanitizeAttributes, type UserUrgency } from '../_shared/attributes.ts'
import {
  DUP_GRAY_ZONE_MIN,
  DUP_RADIUS_M,
  DUP_SIM_THRESHOLD,
  DUP_WINDOW_HOURS,
  FOOD_DEFAULT_SAFE_HOURS,
  GEO_BIAS,
} from '../_shared/config.ts'
import { type GeocodeResult, geocodeReport, isValidLatLng, pointWkt } from '../_shared/geocode.ts'
import { background, HttpError, json, readJson, serve } from '../_shared/http.ts'
import { escalateCluster, listRouted } from '../_shared/route.ts'
import { adminClient, requireUser } from '../_shared/supabase.ts'
import {
  type AiMeta,
  type Category,
  CATEGORIES,
  type Extraction,
  type Lang,
  type PhotoCheck,
  type ProcessReportResponse,
  type Provider,
  type ReportStatus,
  type RoutedOrg,
  type Urgency,
  URGENCIES,
} from '../_shared/types.ts'
import { verifyCluster, type VerifyResult } from '../_shared/verify.ts'

const MAX_IMAGES = 3
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const MAX_TEXT = 4000
const SAME_INCIDENT_CANDIDATES = 2
const MAX_TURNS = 24
const MAX_TURN_TEXT = 1500
const MAX_AUDIO_PATHS = 12

const REJECTED_MESSAGE = {
  message_en: 'This does not look like a report of a local problem, so it was not added to the map. ' +
    'If it is a real problem, please describe it again.',
  message_ur: 'یہ کسی مقامی مسئلے کی رپورٹ نہیں لگتی، اس لیے اسے نقشے پر شامل نہیں کیا گیا۔ ' +
    'اگر یہ اصل مسئلہ ہے تو براہ کرم دوبارہ بتائیں۔',
}

const NO_SPEECH_MESSAGE = {
  message_en: 'We could not hear anything in the voice note. Please hold the mic button and speak again, ' +
    'or type it, or send a photo.',
  message_ur: 'آواز میں کچھ سنائی نہیں دیا۔ براہ کرم مائیک کا بٹن دبا کر دوبارہ بولیں، یا لکھ کر بتائیں، یا تصویر بھیجیں۔',
}

const TOO_SHORT_MESSAGE = {
  message_en: 'We heard only a word or two. Please say a little more: what is the problem, and where is it?',
  message_ur: 'ہمیں صرف ایک دو لفظ سنائی دیے۔ براہ کرم تھوڑا اور بتائیں: مسئلہ کیا ہے اور کہاں ہے؟',
}

// ------------------------------------------------------------------------------------------- helpers

/** One turn of the AI intake conversation (server mirror of ChatTurn in src/lib/attributes.ts). */
interface ChatTurn {
  role: 'user' | 'ai'
  text: string
  text_alt?: string
  at: string
  audio_path?: string
  audio_url?: string
}

interface Body {
  client_id: string
  text: string
  audio_path: string | null
  image_paths: string[]
  point: { lat: number; lng: number } | null
  accuracy_m: number | null
  location_source: 'gps' | 'map' | 'geocoded'
  address_text: string
  language: 'ur' | 'en' | 'pa' | 'auto'
  ui_language: Lang
  category_hint: Category | undefined
  // Phase 1b
  conversation: ChatTurn[] | null
  attributes: AttributeMap
  user_urgency: UserUrgency | null
  intake_session_id: string | null
  /** every voice file of this report (audio_path + audio_paths + conversation turns), de-duplicated */
  all_audio_paths: string[]
}

const USER_URGENCIES: UserUrgency[] = ['emergency', 'urgent', 'can_wait']

const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const safePath = (p: string) => p.length > 2 && p.length < 400 && !p.includes('..') && !p.startsWith('/') && !p.includes('\\')

function ownAudioPath(raw: unknown, userId: string, field: string): string | null {
  const p = str(raw, 400)
  if (!p) return null
  if (!safePath(p)) throw new HttpError(400, `Invalid ${field}`, 'bad_request')
  // report-audio is private: a caller may only submit audio from their own folder ({auth.uid()}/...)
  if (!p.startsWith(`${userId}/`)) throw new HttpError(403, `${field} must be inside your own folder`, 'forbidden')
  return p
}

function parseConversation(raw: unknown, userId: string): ChatTurn[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChatTurn[] = []
  for (const item of raw.slice(-MAX_TURNS)) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const role = t.role === 'ai' ? 'ai' : t.role === 'user' ? 'user' : null
    if (!role) continue
    const text = str(t.text, MAX_TURN_TEXT).replace(/\s+/g, ' ')
    const at = str(t.at, 40)
    const turn: ChatTurn = { role, text, at: at && !Number.isNaN(Date.parse(at)) ? at : new Date().toISOString() }
    const alt = str(t.text_alt, MAX_TURN_TEXT)
    if (role === 'ai' && alt) turn.text_alt = alt
    if (role === 'user') {
      const p = str(t.audio_path, 400)
      // a turn's audio outside the caller's folder is dropped (never trusted), not fatal
      if (p && safePath(p) && p.startsWith(`${userId}/`)) turn.audio_path = p
    } else {
      const u = str(t.audio_url, 600)
      if (/^https:\/\//.test(u)) turn.audio_url = u
    }
    if (!turn.text && !turn.audio_path) continue
    out.push(turn)
  }
  return out.length ? out : null
}

function parseUserUrgency(v: unknown, attrs: AttributeMap): UserUrgency | null {
  const s = str(v, 20).toLowerCase()
  if ((USER_URGENCIES as string[]).includes(s)) return s as UserUrgency
  // fall back to the user_urgency attribute the intake filled in (value may be "emergency" or "Emergency")
  const a = attrs.user_urgency
  const val = `${a?.value_en ?? ''}`.toLowerCase()
  if (/emergen/.test(val)) return 'emergency'
  if (/urgent/.test(val)) return 'urgent'
  if (/wait|can_wait|later/.test(val)) return 'can_wait'
  return null
}

const USER_URGENCY_ATTR: Record<UserUrgency, { en: string; ur: string; severity: ReportAttribute['severity'] }> = {
  emergency: { en: 'Emergency', ur: 'ایمرجنسی', severity: 'danger' },
  urgent: { en: 'Urgent', ur: 'فوری', severity: 'warn' },
  can_wait: { en: 'Can wait', ur: 'انتظار ہو سکتا ہے', severity: 'info' },
}

function validate(raw: unknown, userId: string): Body {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Body must be a JSON object', 'bad_request')
  const b = raw as Record<string, unknown>
  const client_id = str(b.client_id, 200)
  if (!client_id) throw new HttpError(400, 'client_id is required', 'bad_request')

  const text = str(b.text, MAX_TEXT)
  const image_paths = Array.isArray(b.image_paths)
    ? [...new Set(b.image_paths.map((p) => str(p, 400)).filter((p) => p && safePath(p)))].slice(0, MAX_IMAGES)
    : []
  const extraAudio = Array.isArray(b.audio_paths)
    ? b.audio_paths.slice(0, MAX_AUDIO_PATHS).map((p) => ownAudioPath(p, userId, 'audio_paths')).filter((p): p is string => !!p)
    : []
  const conversation = parseConversation(b.conversation, userId)
  // without a conversation, a lone audio_paths entry is THE voice note (transcribed like audio_path)
  const audio_path = ownAudioPath(b.audio_path, userId, 'audio_path') ?? (conversation ? null : extraAudio[0] ?? null)
  const attributes = sanitizeAttributes(b.attributes)
  const user_urgency = parseUserUrgency(b.user_urgency, attributes)
  if (user_urgency && !attributes.user_urgency) {
    const m = USER_URGENCY_ATTR[user_urgency]
    attributes.user_urgency = {
      key: 'user_urgency', label_en: 'How urgent', label_ur: 'کتنا ضروری', value_en: m.en, value_ur: m.ur,
      icon: 'siren', severity: m.severity, source: 'user',
    }
  }
  const all_audio_paths = [...new Set([
    ...(audio_path ? [audio_path] : []),
    ...extraAudio,
    ...(conversation ?? []).map((t) => t.audio_path).filter((p): p is string => !!p),
  ])].slice(0, MAX_AUDIO_PATHS)
  const hasConversationContent = Boolean(conversation?.some((t) => t.role === 'user'))
  if (!text && !audio_path && !image_paths.length && !hasConversationContent && !extraAudio.length) {
    throw new HttpError(400, 'Send a voice note, a photo or some text', 'empty_report')
  }

  const lat = typeof b.lat === 'string' ? Number(b.lat) : b.lat
  const lng = typeof b.lng === 'string' ? Number(b.lng) : b.lng
  const point = isValidLatLng(lat, lng) ? { lat: lat as number, lng: lng as number } : null
  const src = b.location_source
  const location_source = src === 'map' || src === 'geocoded' || src === 'gps' ? src : 'gps'
  const acc = Number(b.accuracy_m)
  const lang = b.language
  const language = lang === 'ur' || lang === 'en' || lang === 'pa' ? lang : 'auto'
  const ui_language: Lang = b.ui_language === 'en' ? 'en' : 'ur'
  const hint = str(b.category_hint, 20) as Category
  return {
    client_id,
    text,
    audio_path,
    image_paths,
    point,
    accuracy_m: Number.isFinite(acc) && acc >= 0 ? acc : null,
    location_source,
    address_text: str(b.address_text, 300),
    language,
    ui_language,
    category_hint: CATEGORIES.includes(hint) ? hint : undefined,
    conversation,
    attributes,
    user_urgency,
    intake_session_id: str(b.intake_session_id, 100) || null,
    all_audio_paths,
  }
}

// ------------------------------------------------------------------------------------------- silence detection
// Same rules as report-chat (ai.ts detectNoSpeech): markers, STT hallucinations on silent audio ("Thank you for
// watching", lone "شکریہ"), greetings and fillers do not count as words.

/** The transcript (whitespace-normalised), or '' when it holds fewer than minWords real words. */
function heardWords(raw: string, minWords: number): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return detectNoSpeech(t, { minWords }).no_speech ? '' : t
}

// ------------------------------------------------------------------------------------------- intake text

const URG_FLOOR: Record<UserUrgency, Urgency> = { emergency: 'high', urgent: 'medium', can_wait: 'low' }
const URG_NOMINAL: Record<UserUrgency, Urgency> = { emergency: 'critical', urgent: 'high', can_wait: 'low' }

function factLines(attrs: AttributeMap, userUrgency: UserUrgency | null): string[] {
  const lines = Object.values(attrs)
    .filter((a) => a.key !== 'user_urgency' && a.value_en)
    .map((a) => `${a.key}: ${a.value_en}${a.value_ur && a.value_ur !== a.value_en ? ` (${a.value_ur})` : ''}`)
  if (userUrgency) {
    const say = userUrgency === 'emergency' ? 'EMERGENCY (danger right now)' : userUrgency === 'urgent' ? 'urgent' : 'can wait'
    lines.push(`citizen's own urgency choice: ${say}`)
  }
  return lines
}

interface IntakeInput {
  /** extraction input (conversation + typed text + facts) */
  text: string
  /** the citizen's own words joined (stored as reports.transcript, returned as "what we heard") */
  heard: string
  voiceTurns: number
  typedTurns: number
  userTurns: number
}

function buildIntake(body: Body): IntakeInput {
  const conv = body.conversation ?? []
  const lines: string[] = []
  const heard: string[] = []
  let voiceTurns = 0
  let typedTurns = 0
  for (const t of conv) {
    if (t.role === 'ai') {
      if (t.text) lines.push(`Assistant: ${t.text}`)
      continue
    }
    // voice turns: drop pure silence / hallucinations (a one-word answer such as "haan" is fine)
    const words = t.audio_path ? heardWords(t.text, 1) : t.text
    if (!words) continue
    lines.push(`Citizen${t.audio_path ? ' (voice)' : ''}: ${words}`)
    heard.push(words)
    if (t.audio_path) voiceTurns++
    else typedTurns++
  }
  if (body.text && !heard.some((h) => h === body.text)) {
    lines.push(`Citizen (typed): ${body.text}`)
    heard.push(body.text)
    typedTurns++
  }
  const facts = factLines(body.attributes, body.user_urgency)
  const userTurns = voiceTurns + typedTurns
  if (!userTurns && !facts.length) return { text: '', heard: '', voiceTurns, typedTurns, userTurns }
  const text = [
    'This report came from a short conversation between the citizen and the Awaaz intake assistant.',
    'Only "Citizen" lines are the citizen\'s own words (voice lines are speech-to-text and may be noisy); ' +
    '"Assistant" lines are the questions that were asked, for context only. Decide "language" from the Citizen lines only.',
    ...lines,
    ...(facts.length ? ['Facts confirmed during the conversation (key: value):', ...facts] : []),
  ].join('\n')
  return { text, heard: heard.join('\n'), voiceTurns, typedTurns, userTurns }
}

// ------------------------------------------------------------------------------------------- food servings

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g

function normalizeDigits(s: string): string {
  return s.replace(ARABIC_INDIC_DIGITS, (d) => {
    const c = d.charCodeAt(0)
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660)
  })
}

const PEOPLE_WORDS = 'people|persons?|servings?|portions?|guests?|plates?|log|logon|logo|logoon|logaon|afraad|afrad|' +
  'aadmi|admi|bande|banday|bandon|mehman|mehmaan|mehmano|children|kids|bachay|bachon|bache|bachchon|' +
  'افراد|لوگ|لوگوں|آدمی|بندے|بندوں|مہمان|مہمانوں|پلیٹ|پلیٹیں|بچے|بچوں'
const STATED_SERVINGS_RES = [
  new RegExp(`(\\d{1,6})\\s*(?:\\+|plus)?\\s*(?:(?:-|to|se|سے)\\s*\\d{1,6}\\s*)?(?:${PEOPLE_WORDS})(?![\\p{L}])`, 'giu'),
  /\bfor\s+(?:about\s+|around\s+|approx(?:imately|\.)?\s+|roughly\s+|nearly\s+)?(\d{1,6})\b(?!\s*(?:hours?|hrs?|days?|minutes?|mins?|weeks?|months?|years?|am|pm|o'?clock|ghant|din|baje|bje|km|m\b|kg|rupees|rs))/gi,
  /(\d{1,6})\s*(?:ke\s+liye|ke\s+liay|kay\s+liye|ke\s+lie|کے\s+لیے|کے\s+لئے|ka\s+khana|ka\s+khaana|کا\s+کھانا)/giu,
]

/** Every serving count the reporter stated in words (text / transcript / attributes). */
function statedServings(texts: string[], attrs: AttributeMap): number[] {
  const nums: number[] = []
  for (const a of Object.values(attrs)) {
    if (!/serving|people_fed|portion|feeds|food_quantity|quantity/.test(a.key)) continue
    const m = normalizeDigits(`${a.value_en} ${a.value_ur}`).match(/\d{1,6}/)
    if (m) nums.push(Number(m[0]))
  }
  for (const raw of texts) {
    if (!raw) continue
    const s = normalizeDigits(raw)
    for (const re of STATED_SERVINGS_RES) {
      re.lastIndex = 0
      for (const m of s.matchAll(re)) nums.push(Number(m[1]))
    }
  }
  return nums.filter((n) => Number.isFinite(n) && n >= 1 && n <= 100000)
}

/** Stated numbers beat the photo estimate; the AI's reading wins when it equals one of them (or their sum). */
function pickStatedServings(stated: number[], aiServings: number | null | undefined): number | null {
  if (!stated.length) return null
  const ai = Number(aiServings)
  if (Number.isFinite(ai) && ai > 0) {
    const sum = [...new Set(stated)].reduce((s, n) => s + n, 0)
    if (stated.includes(ai) || ai === sum) return ai
  }
  return stated[0]
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(s)
}

function audioMime(path: string, blobType: string): string {
  if (blobType && /^(audio|video)\//.test(blobType)) return blobType.split(';')[0]
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    mp3: 'audio/mpeg', mpeg: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', '3gp': 'audio/3gpp',
  }
  return map[ext] ?? 'audio/webm'
}

const URG_RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const maxUrgency = (a: Urgency, b: Urgency): Urgency => (URG_RANK[b] > URG_RANK[a] ? b : a)

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Stage timer: logs each stage's duration; summary at the end. */
function stageTimer(clientId: string) {
  const t0 = performance.now()
  const timings: Record<string, number> = {}
  return {
    timings,
    async run<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const s = performance.now()
      try {
        return await fn()
      } finally {
        timings[stage] = Math.round(performance.now() - s)
        console.log(`[process-report] ${clientId} ${stage} ${timings[stage]}ms`)
      }
    },
    total: () => Math.round(performance.now() - t0),
  }
}

function photoOnlyClaim(hint: Category | undefined): Extraction {
  return {
    category: hint ?? 'other',
    urgency: 'medium',
    title_en: 'Photo-only report',
    title_ur: 'صرف تصویر والی رپورٹ',
    summary_en: 'The citizen sent only a photo, with no words. Describe the local civic problem visible in the photo ' +
      '(what it is, how serious, any landmark or sign that shows the place).',
    summary_ur: 'شہری نے صرف تصویر بھیجی ہے۔',
    canonical_en: '',
    location_hints: [],
    language: 'ur',
    is_spam: false,
    spam_reason: null,
    food: null,
    confidence_notes: 'photo only',
  }
}

/** Last-resort extraction when every AI model is down: keeps the report flowing (pin + routing by hint). */
function basicExtraction(words: string, hint: Category | undefined, uiLang: Lang): Extraction {
  const clean = words.replace(/\s+/g, ' ').trim()
  const title = clean.split(' ').slice(0, 8).join(' ') || 'Citizen report'
  const urdu = /[؀-ۿ]/.test(clean)
  return {
    category: hint ?? 'other',
    urgency: 'medium',
    title_en: urdu ? 'Citizen report' : title,
    title_ur: urdu ? title : 'شہری کی رپورٹ',
    summary_en: urdu ? 'Citizen report (automatic summary unavailable).' : clean.slice(0, 300) || 'Citizen report.',
    summary_ur: urdu ? clean.slice(0, 300) : 'شہری کی رپورٹ (خودکار خلاصہ دستیاب نہیں)۔',
    canonical_en: clean.toLowerCase().slice(0, 200),
    location_hints: [],
    language: urdu ? 'ur' : uiLang === 'en' ? 'en' : 'mixed',
    is_spam: false,
    spam_reason: null,
    food: null,
    confidence_notes: 'AI extraction unavailable: basic fallback',
  }
}

/** Silence / too-short voice note: HTTP 200, nothing stored; the client plays noSpeech / tooShort and stays on the mic. */
function noSpeechResult(heard: string, tooShort: boolean): Result {
  return {
    report_id: '',
    cluster_id: null,
    is_duplicate: false,
    similarity: null,
    status: 'unconfirmed',
    confidence: 0,
    category: 'other',
    urgency: 'low',
    title_en: '',
    title_ur: '',
    summary_en: '',
    summary_ur: '',
    ai_reason: null,
    routed: [],
    ai_provider: 'openai',
    transcript: heard || undefined,
    food: null,
    rejected: { reason: 'no_speech', ...(tooShort ? TOO_SHORT_MESSAGE : NO_SPEECH_MESSAGE) },
  }
}

// ------------------------------------------------------------------------------------------- stored result (idempotency)

const REPORT_RESULT_COLS = 'id, cluster_id, category, urgency, status, confidence, ai_reason, title_en, title_ur, ' +
  'summary_en, summary_ur, transcript, is_spam, spam_reason, ai_provider, food_servings, food_type, safe_until, extraction, ' +
  'attributes, user_urgency'

/** process-report response (contract shape) + Phase-1b additions. */
type Result = ProcessReportResponse & {
  attributes?: AttributeMap
  user_urgency?: UserUrgency | null
  location?: { lat: number; lng: number; source: string; label?: string }
}

interface StoredReport {
  id: string
  cluster_id: string | null
  category: Category
  urgency: Urgency
  status: ReportStatus
  confidence: number
  ai_reason: string | null
  title_en: string | null
  title_ur: string | null
  summary_en: string | null
  summary_ur: string | null
  transcript: string | null
  is_spam: boolean
  spam_reason: string | null
  ai_provider: string | null
  food_servings: number | null
  food_type: string | null
  safe_until: string | null
  extraction: { _pipeline?: { similarity?: number | null } } | null
  attributes: AttributeMap | null
  user_urgency: UserUrgency | null
}

async function storedResult(r: StoredReport): Promise<Result> {
  const base: Result = {
    report_id: r.id,
    cluster_id: r.cluster_id,
    is_duplicate: false,
    similarity: r.extraction?._pipeline?.similarity ?? null,
    status: r.status,
    confidence: r.confidence ?? 0,
    category: r.category,
    urgency: r.urgency,
    title_en: r.title_en ?? '',
    title_ur: r.title_ur ?? '',
    summary_en: r.summary_en ?? '',
    summary_ur: r.summary_ur ?? '',
    ai_reason: r.ai_reason,
    routed: [],
    ai_provider: (r.ai_provider ?? 'openai') as Provider,
    transcript: r.transcript ?? undefined,
    food: r.category === 'food' && r.safe_until
      ? { servings: r.food_servings ?? 0, safe_until: r.safe_until, food_type: r.food_type ?? '' }
      : null,
    attributes: r.attributes ?? {},
    user_urgency: r.user_urgency ?? null,
  }
  if (r.is_spam || !r.cluster_id) {
    return { ...base, cluster_id: null, rejected: { reason: r.spam_reason ?? 'not a local civic issue', ...REJECTED_MESSAGE } }
  }
  const [{ data: c }, routed] = await Promise.all([
    adminClient().from('clusters').select('status, confidence, ai_reason, primary_report_id').eq('id', r.cluster_id).maybeSingle(),
    listRouted(r.cluster_id),
  ])
  const cl = c as { status: ReportStatus; confidence: number; ai_reason: string | null; primary_report_id: string | null } | null
  return {
    ...base,
    is_duplicate: Boolean(cl?.primary_report_id && cl.primary_report_id !== r.id),
    status: cl?.status ?? base.status,
    confidence: cl?.confidence ?? base.confidence,
    ai_reason: cl?.ai_reason ?? base.ai_reason,
    routed: routed.map(publicRouted),
  }
}

const publicRouted = (o: RoutedOrg) => ({ org_name: o.org_name, org_type: o.org_type, distance_m: o.distance_m })

async function findExisting(reporterId: string, clientId: string): Promise<StoredReport | null> {
  const { data, error } = await adminClient().from('reports').select(REPORT_RESULT_COLS)
    .eq('reporter_id', reporterId).eq('client_id', clientId).maybeSingle()
  if (error) throw new Error(`idempotency lookup failed: ${error.message}`)
  return (data as unknown as StoredReport) ?? null
}

// ------------------------------------------------------------------------------------------- handler

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST', 'method_not_allowed')
  const user = await requireUser(req)
  const body = validate(await readJson<unknown>(req), user.id)
  const admin = adminClient()
  const T = stageTimer(body.client_id)

  // ---- 0. idempotency
  const prior = await T.run('idempotency', () => findExisting(user.id, body.client_id))
  if (prior) {
    console.log(`[process-report] ${body.client_id} replay of stored report ${prior.id}`)
    return json(await storedResult(prior))
  }

  // ---- 1. media: audio -> transcript, images -> data URLs (in parallel).
  // With an intake conversation every voice turn was already transcribed by report-chat: never re-transcribe.
  const intake = body.conversation ? buildIntake(body) : null
  const audioP = body.audio_path && !intake
    ? T.run('audio', async () => {
      const { data: blob, error } = await admin.storage.from('report-audio').download(body.audio_path!)
      if (error || !blob) throw new Error(`audio download failed: ${error?.message ?? 'no data'}`)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!bytes.byteLength) throw new Error('audio file is empty')
      if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('audio file too large')
      return await transcribe(bytes, audioMime(body.audio_path!, blob.type), body.language)
    }).catch((e) => {
      console.error('[process-report] audio/transcribe failed:', errMsg(e))
      return { error: errMsg(e) }
    })
    : Promise.resolve(null)

  const imagesP = body.image_paths.length
    ? T.run('images', async () => {
      const out = await Promise.all(body.image_paths.map(async (path) => {
        try {
          const { data: blob, error } = await admin.storage.from('report-images').download(path)
          if (error || !blob) throw new Error(error?.message ?? 'no data')
          if (blob.size > MAX_IMAGE_BYTES) throw new Error('image too large')
          const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg'
          return { path, url: `data:${mime};base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}` }
        } catch (e) {
          console.warn('[process-report] image download failed', path, errMsg(e))
          return null
        }
      }))
      return out.filter((x): x is { path: string; url: string } => x !== null)
    })
    : Promise.resolve([] as { path: string; url: string }[])

  const [audioRes, images] = await Promise.all([audioP, imagesP])
  const transcription = audioRes && !('error' in audioRes) ? audioRes : null
  const rawTranscript = transcription?.text?.trim() ?? ''
  const imageUrls = images.map((i) => i.url)
  const facts = factLines(body.attributes, body.user_urgency)
  // silence / STT hallucination on silent audio => no words. A voice note on its own needs >= 2 real words;
  // next to typed text or a photo any real word is kept.
  const speech = detectNoSpeech(rawTranscript, { minWords: 2 })
  const transcript = heardWords(rawTranscript, body.text || imageUrls.length ? 1 : 2)
  const heard = intake ? intake.heard : transcript
  const hasWords = intake ? Boolean(intake.text) : Boolean(body.text || transcript)

  if (!hasWords && !imageUrls.length) {
    if (audioRes && 'error' in audioRes) {
      throw new HttpError(502, 'Could not process the voice note. Please try again or type it.', 'transcription_failed')
    }
    if (transcription || intake || (!body.text && !body.image_paths.length)) {
      // never create a report from silence: friendly 200 so the client speaks a prompt and lets them retry
      const tooShort = !intake && speech.reason === 'too_short'
      console.log(`[process-report] ${body.client_id} no_speech ${speech.reason ?? ''} (heard: ${JSON.stringify(rawTranscript.slice(0, 80))}) total ${T.total()}ms`)
      return json(noSpeechResult(tooShort ? rawTranscript : '', tooShort))
    }
    throw new HttpError(422, 'The photos could not be read. Please send them again.', 'media_unavailable')
  }

  // ---- 2. extraction (photo-only reports: photo first, then extract from the vision description)
  let extraction: Extraction
  let extractMeta: AiMeta | null = null
  let photo: PhotoCheck | null = null
  let visionMeta: AiMeta | null = null
  let extractFallback = false
  if (hasWords) {
    // conversation: one structured block (citizen turns + AI questions + facts); else text (+ facts) and transcript
    const extractText = intake
      ? intake.text
      : [body.text, ...(facts.length ? ['Facts given by the citizen (key: value):', ...facts] : [])].filter(Boolean).join('\n')
    try {
      const r = await T.run('extract', () =>
        extractReport({
          text: extractText || undefined,
          transcript: intake ? undefined : transcript || undefined,
          uiLanguage: body.ui_language,
          addressText: body.address_text || undefined,
          categoryHint: body.category_hint,
        }))
      extraction = r.data
      extractMeta = r.meta
    } catch (e) {
      console.error('[process-report] extraction failed, basic fallback:', errMsg(e))
      extraction = basicExtraction(intake ? intake.heard.replace(/\n/g, ' ') : [transcript, body.text].filter(Boolean).join(' '),
        body.category_hint, body.ui_language)
      extractFallback = true
    }
  } else {
    try {
      const pc = await T.run('vision_first', () => checkPhoto({ imageUrls, claim: photoOnlyClaim(body.category_hint) }))
      photo = pc.data
      visionMeta = pc.meta
    } catch (e) {
      console.error('[process-report] photo-only vision failed:', errMsg(e))
    }
    try {
      const described = photo
        ? `Photo-only report (the citizen sent no words). An AI vision check describes the photo as: "${photo.notes}" ` +
          `(visible severity: ${photo.severity}${photo.food_type ? `; food: ${photo.food_type}, about ${photo.servings_estimate ?? '?'} servings` : ''}).`
        : undefined
      const withFacts = [described, ...(facts.length ? ['Facts given by the citizen (key: value):', ...facts] : [])]
        .filter(Boolean).join('\n')
      const r = await T.run('extract', () =>
        extractReport({
          text: withFacts || undefined,
          uiLanguage: body.ui_language,
          addressText: body.address_text || undefined,
          categoryHint: body.category_hint,
        }))
      extraction = { ...r.data, language: body.ui_language }
      extractMeta = r.meta
    } catch (e) {
      console.error('[process-report] photo-only extraction failed, basic fallback:', errMsg(e))
      extraction = basicExtraction(photo?.notes ?? '', body.category_hint, body.ui_language)
      extractFallback = true
    }
    // the claim was derived from this very photo
    if (photo && !extraction.is_spam) photo = { ...photo, matches_claim: true }
  }
  const aiProvider = (extractMeta?.provider ?? (extractFallback ? 'none' : 'openai')) as Provider

  const inputModes: string[] = []
  const audioCount = body.all_audio_paths.length
  const usedVoice = intake ? intake.voiceTurns > 0 || audioCount > 0 : Boolean(transcript)
  // intake turns not tagged with their audio (client sent audio_paths separately) count as voice
  const usedText = intake ? (intake.voiceTurns > 0 || !audioCount ? intake.typedTurns > 0 : Boolean(body.text)) : Boolean(body.text)
  if (usedVoice) inputModes.push('voice')
  if (images.length) inputModes.push('photo')
  if (usedText) inputModes.push('text')
  const mediaRows = (reportId: string) => [
    ...body.all_audio_paths.map((p) => ({ report_id: reportId, type: 'audio', storage_path: p, bucket: 'report-audio' })),
    ...images.map((i) => ({ report_id: reportId, type: 'image', storage_path: i.path, bucket: 'report-images' })),
  ]
  const transcriptOut = heard || undefined
  // Phase-1b columns shared by both inserts
  const intakeCols = {
    attributes: body.attributes,
    conversation: body.conversation,
    user_urgency: body.user_urgency,
    intake_session_id: body.intake_session_id,
  }
  const intakeMeta = intake
    ? { turns: body.conversation?.length ?? 0, user_turns: intake.userTurns, voice_turns: intake.voiceTurns, session: body.intake_session_id }
    : null

  // ---- 3. spam: store (no cluster), tell the user kindly
  if (extraction.is_spam) {
    const p = body.point ?? { lat: GEO_BIAS.lat, lng: GEO_BIAS.lng }
    const { data: ins, error } = await admin.from('reports').insert({
      reporter_id: user.id,
      client_id: body.client_id,
      cluster_id: null,
      category: extraction.category,
      urgency: extraction.urgency,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
      canonical_en: extraction.canonical_en,
      transcript: heard || null,
      language: extraction.language,
      input_modes: inputModes,
      location: pointWkt(p.lat, p.lng),
      location_source: body.point ? body.location_source : 'fallback',
      address_text: body.address_text || null,
      location_hints: extraction.location_hints,
      status: 'unconfirmed',
      confidence: 0,
      is_spam: true,
      spam_reason: extraction.spam_reason ?? 'not a local civic issue',
      photo_check: photo,
      extraction: { ...extraction, _pipeline: { timings_ms: T.timings, extract_model: extractMeta?.model, intake: intakeMeta } },
      ai_provider: aiProvider,
      ...intakeCols,
    }).select('id').single()
    if (error) {
      if (error.code === '23505') {
        const again = await findExisting(user.id, body.client_id)
        if (again) return json(await storedResult(again))
      }
      throw new Error(`spam report insert failed: ${error.message}`)
    }
    const reportId = (ins as { id: string }).id
    const media = mediaRows(reportId)
    if (media.length) {
      const { error: mErr } = await admin.from('report_media').insert(media)
      if (mErr) console.warn('[process-report] media insert failed', mErr.message)
    }
    console.log(`[process-report] ${body.client_id} rejected as spam (${extraction.spam_reason}) total ${T.total()}ms`)
    const res: Result = {
      report_id: reportId,
      cluster_id: null,
      is_duplicate: false,
      similarity: null,
      status: 'unconfirmed',
      confidence: 0,
      category: extraction.category,
      urgency: extraction.urgency,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
      ai_reason: null,
      routed: [],
      ai_provider: aiProvider,
      transcript: transcriptOut,
      food: null,
      rejected: { reason: extraction.spam_reason ?? 'not a local civic issue', ...REJECTED_MESSAGE },
      attributes: body.attributes,
      user_urgency: body.user_urgency,
    }
    return json(res)
  }

  // ---- 4. in parallel: photo check (claim known), embedding, location
  const photoP: Promise<PhotoCheck | null> = hasWords && imageUrls.length
    ? T.run('vision', () => checkPhoto({ imageUrls, claim: extraction })).then((r) => {
      visionMeta = r.meta
      return r.data
    }).catch((e) => {
      console.error('[process-report] photo check failed:', errMsg(e))
      return null
    })
    : Promise.resolve(photo)
  const embedP = T.run('embed', () => embed(extraction.canonical_en || extraction.summary_en)).catch((e) => {
    console.error('[process-report] embedding failed (no duplicate matching):', errMsg(e))
    return null
  })
  let geocoded: GeocodeResult | null = null
  const locationP: Promise<{ lat: number; lng: number; source: string } | null> = body.point
    ? Promise.resolve({ ...body.point, source: body.location_source })
    : T.run('geocode', () => geocodeReport(body.address_text, extraction.location_hints)).then((g) => {
      geocoded = g
      return g ? { lat: g.lat, lng: g.lng, source: 'geocoded' } : null
    })

  const location = await locationP
  if (!location) {
    console.log(`[process-report] ${body.client_id} needs_location (hints: ${extraction.location_hints.join(' | ')}) total ${T.total()}ms`)
    throw new HttpError(422, 'Where is this? Please pick the place on the map.', 'needs_location', {
      needs_location: { hints: extraction.location_hints },
      transcript: transcriptOut,
      category: extraction.category,
      urgency: extraction.urgency,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
    })
  }
  const [photoCheck, embedding] = await Promise.all([photoP, embedP])

  // photo evidence can raise urgency (never lower it)
  let urgency: Urgency = URGENCIES.includes(extraction.urgency) ? extraction.urgency : 'medium'
  if (photoCheck?.matches_claim && URGENCIES.includes(photoCheck.severity)) urgency = maxUrgency(urgency, photoCheck.severity)
  // the citizen's own urgency is a floor one level below their choice (emergency => at least high); the AI may go higher
  if (body.user_urgency) {
    const floor = URG_FLOOR[body.user_urgency]
    const nominal = URG_NOMINAL[body.user_urgency]
    const before = urgency
    urgency = maxUrgency(urgency, floor)
    const notes: string[] = []
    if (urgency !== before) notes.push(`urgency raised from ${before} to ${urgency}: citizen marked it "${body.user_urgency}"`)
    if (URG_RANK[urgency] < URG_RANK[nominal]) {
      notes.push(`citizen chose "${body.user_urgency}" but the AI assessed ${urgency} (kept within one level of the citizen's choice)`)
    }
    if (notes.length) {
      extraction = { ...extraction, confidence_notes: [extraction.confidence_notes, ...notes].filter((s) => s && s !== 'clear').join('; ') }
    }
  }

  // food rescue fields
  // (only for food on offer — a "people need food" report has no servings / shelf life)
  const isFood = extraction.category === 'food' &&
    Boolean(extraction.food || photoCheck?.food_type || photoCheck?.servings_estimate)
  // a number the reporter stated (text / transcript / attributes) beats the photo estimate
  const stated = isFood
    ? statedServings([body.text, intake ? intake.heard : transcript], body.attributes)
    : []
  const statedPick = isFood ? pickStatedServings(stated, extraction.food?.servings_estimate) : null
  const foodServings = isFood
    ? (statedPick ?? photoCheck?.servings_estimate ?? extraction.food?.servings_estimate ?? null)
    : null
  const foodType = isFood ? (extraction.food?.food_type || photoCheck?.food_type || null) : null
  const safeUntil = isFood
    ? new Date(Date.now() + (extraction.food?.safe_hours || FOOD_DEFAULT_SAFE_HOURS) * 3600_000).toISOString()
    : null

  // ---- 5. duplicate matching
  const vecLiteral = embedding ? `[${embedding.vector.join(',')}]` : null
  let clusterId: string | null = null
  let similarity: number | null = null
  let matchMethod: 'embedding' | 'same_incident' | 'new' = 'new'
  let sameReason: string | null = null
  if (embedding && vecLiteral) {
    const { data: rows, error } = await T.run('match', async () =>
      await admin.rpc('match_cluster', {
        p_category: extraction.category,
        p_lat: location.lat,
        p_lng: location.lng,
        p_embedding: vecLiteral,
        p_embedding_model: embedding.model,
        p_radius_m: DUP_RADIUS_M,
        p_hours: DUP_WINDOW_HOURS,
        p_limit: 5,
      }))
    if (error) console.error('[process-report] match_cluster failed:', error.message)
    const best = new Map<string, { cluster_id: string; report_id: string; similarity: number; distance_m: number }>()
    for (const r of (rows ?? []) as { cluster_id: string; report_id: string; similarity: number; distance_m: number }[]) {
      const s = Number(r.similarity)
      if (!r.cluster_id || !Number.isFinite(s)) continue
      const cur = best.get(r.cluster_id)
      if (!cur || s > cur.similarity) best.set(r.cluster_id, { ...r, similarity: s })
    }
    const ranked = [...best.values()].sort((a, b) => b.similarity - a.similarity)
    if (ranked.length) similarity = Math.round(ranked[0].similarity * 1000) / 1000
    if (ranked[0] && ranked[0].similarity >= DUP_SIM_THRESHOLD) {
      clusterId = ranked[0].cluster_id
      matchMethod = 'embedding'
    } else {
      const gray = ranked.filter((r) => r.similarity >= DUP_GRAY_ZONE_MIN && r.similarity < DUP_SIM_THRESHOLD)
        .slice(0, SAME_INCIDENT_CANDIDATES)
      if (gray.length) {
        const { data: cand } = await admin.from('reports').select('id, canonical_en, summary_en')
          .in('id', gray.map((g) => g.report_id))
        const textOf = new Map(((cand ?? []) as { id: string; canonical_en: string | null; summary_en: string | null }[])
          .map((c) => [c.id, [c.summary_en, c.canonical_en ? `(${c.canonical_en})` : ''].filter(Boolean).join(' ')]))
        const mine = [extraction.summary_en, extraction.canonical_en ? `(${extraction.canonical_en})` : ''].filter(Boolean).join(' ')
        const verdicts = await T.run('same_incident', () =>
          Promise.all(gray.map(async (g) => {
            const other = textOf.get(g.report_id)
            if (!other) return { g, same: false, reason: 'candidate text missing' }
            try {
              const v = await sameIncident(mine, other)
              return { g, same: v.same, reason: v.reason }
            } catch (e) {
              console.warn('[process-report] sameIncident failed:', errMsg(e))
              return { g, same: false, reason: 'adjudication unavailable' }
            }
          })))
        const hit = verdicts.find((v) => v.same)
        if (hit) {
          clusterId = hit.g.cluster_id
          similarity = Math.round(hit.g.similarity * 1000) / 1000
          matchMethod = 'same_incident'
          sameReason = hit.reason
        }
      }
    }
  }
  const isDuplicate = clusterId !== null
  const nowIso = new Date().toISOString()

  // ---- 6. create cluster (new incident)
  let createdCluster = false
  if (!clusterId) {
    const { data: c, error } = await admin.from('clusters').insert({
      category: extraction.category,
      urgency,
      centroid: pointWkt(location.lat, location.lng),
      status: 'unconfirmed',
      confidence: 0,
      title_en: extraction.title_en,
      title_ur: extraction.title_ur,
      summary_en: extraction.summary_en,
      summary_ur: extraction.summary_ur,
      photo_path: images[0]?.path ?? null,
      food_servings: foodServings,
      food_type: foodType,
      safe_until: safeUntil,
      last_report_at: nowIso,
      attributes: body.attributes,          // recompute_cluster re-merges from the reports
      user_urgency: body.user_urgency,
    }).select('id').single()
    if (error) throw new Error(`cluster insert failed: ${error.message}`)
    clusterId = (c as { id: string }).id
    createdCluster = true
  }

  // ---- 7. insert report
  const { data: rep, error: repErr } = await admin.from('reports').insert({
    reporter_id: user.id,
    client_id: body.client_id,
    cluster_id: clusterId,
    category: extraction.category,
    urgency,
    title_en: extraction.title_en,
    title_ur: extraction.title_ur,
    summary_en: extraction.summary_en,
    summary_ur: extraction.summary_ur,
    canonical_en: extraction.canonical_en,
    transcript: heard || null,
    language: extraction.language || transcription?.language || null,
    input_modes: inputModes,
    embedding: vecLiteral,
    embedding_model: embedding?.model ?? null,
    location: pointWkt(location.lat, location.lng),
    location_source: location.source,
    address_text: body.address_text || null,
    location_hints: extraction.location_hints,
    status: 'unconfirmed',
    confidence: 0,
    is_spam: false,
    photo_check: photoCheck,
    extraction: {
      ...extraction,
      _pipeline: {
        similarity,
        is_duplicate: isDuplicate,
        match: matchMethod,
        same_incident_reason: sameReason,
        transcribe_model: transcription?.meta.model ?? null,
        extract_model: extractMeta?.model ?? null,
        extract_fallback: extractFallback || Boolean(extractMeta?.fallback),
        vision_model: (visionMeta as AiMeta | null)?.model ?? null,
        embed_model: embedding?.model ?? null,
        accuracy_m: body.accuracy_m,
        geocode: geocoded ? { label: (geocoded as GeocodeResult).label, source: (geocoded as GeocodeResult).source, query: (geocoded as GeocodeResult).query } : null,
        intake: intakeMeta,
        food_servings_source: isFood ? (statedPick != null ? 'stated' : photoCheck?.servings_estimate != null ? 'photo' : 'ai') : null,
        timings_ms: T.timings,
      },
    },
    ai_provider: aiProvider,
    food_servings: foodServings,
    food_type: foodType,
    safe_until: safeUntil,
    ...intakeCols,
  }).select('id').single()
  if (repErr) {
    if (createdCluster) await admin.from('clusters').delete().eq('id', clusterId)
    if (repErr.code === '23505') {
      const again = await findExisting(user.id, body.client_id)
      if (again) return json(await storedResult(again))
    }
    throw new Error(`report insert failed: ${repErr.message}`)
  }
  const reportId = (rep as { id: string }).id
  const cid = clusterId as string

  // ---- 8. media rows + cluster bookkeeping, then recompute aggregates
  await T.run('persist', async () => {
    const media = mediaRows(reportId)
    const [mRes, cRes] = await Promise.all([
      media.length ? admin.from('report_media').insert(media) : Promise.resolve({ error: null }),
      createdCluster
        ? admin.from('clusters').update({ primary_report_id: reportId }).eq('id', cid)
        : admin.from('clusters').update({ last_report_at: nowIso }).eq('id', cid),
    ])
    if (mRes.error) console.warn('[process-report] media insert failed', mRes.error.message)
    if (cRes.error) console.warn('[process-report] cluster bookkeeping failed', cRes.error.message)
    const { error } = await admin.rpc('recompute_cluster', { p_cluster_id: cid })
    if (error) console.error('[process-report] recompute_cluster failed', error.message)
  })

  // ---- 9. verify inline
  let v: Pick<VerifyResult, 'status' | 'confidence' | 'reason' | 'changed_to_verified'>
  try {
    v = await T.run('verify', () => verifyCluster(cid))
  } catch (e) {
    console.error('[process-report] verify failed:', errMsg(e))
    const { data } = await admin.from('clusters').select('status, confidence, ai_reason').eq('id', cid).maybeSingle()
    const c = data as { status: ReportStatus; confidence: number; ai_reason: string | null } | null
    v = { status: c?.status ?? 'unconfirmed', confidence: c?.confidence ?? 0, reason: c?.ai_reason ?? '', changed_to_verified: false }
  }

  // ---- 10. route inline (verified or high/critical) + nearby alerts / reporter updates in background
  const routed = await T.run('route', () => escalateCluster(cid, v, { excludeReporterIds: [user.id] }))

  // keep the reporter's last location fresh for nearby alerts (GPS only)
  if (body.point && body.location_source === 'gps') {
    const p = body.point
    background((async () => {
      const { error } = await admin.from('profiles').update({
        last_location: pointWkt(p.lat, p.lng),
        last_location_at: nowIso,
      }).eq('id', user.id)
      if (error) console.warn('[process-report] last_location update failed', error.message)
    })())
  }

  const res: Result = {
    report_id: reportId,
    cluster_id: cid,
    is_duplicate: isDuplicate,
    similarity,
    status: v.status,
    confidence: v.confidence,
    category: extraction.category,
    urgency,
    title_en: extraction.title_en,
    title_ur: extraction.title_ur,
    summary_en: extraction.summary_en,
    summary_ur: extraction.summary_ur,
    ai_reason: v.reason || null,
    routed: routed.map(publicRouted),
    ai_provider: aiProvider,
    transcript: transcriptOut,
    food: isFood && safeUntil ? { servings: foodServings ?? 0, safe_until: safeUntil, food_type: foodType ?? '' } : null,
    location: {
      lat: location.lat,
      lng: location.lng,
      source: location.source,
      ...(geocoded ? { label: (geocoded as GeocodeResult).label } : {}),
    },
    attributes: body.attributes,
    user_urgency: body.user_urgency,
  }
  console.log(JSON.stringify({
    fn: 'process-report', client_id: body.client_id, report_id: reportId, cluster_id: cid, match: matchMethod,
    similarity, status: v.status, confidence: v.confidence, routed: routed.length, modes: inputModes,
    intake: Boolean(intake), user_urgency: body.user_urgency, timings_ms: T.timings, total_ms: T.total(),
  }))
  return json(res)
})
