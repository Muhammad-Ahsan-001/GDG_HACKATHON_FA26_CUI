// SOS threat detection (docs/CONTRACT-1B.md §SOS): a deterministic keyword pass (forces 'high') followed by one
// OpenAI strict-JSON classification over the recent transcript window. Never throws: on AI failure the keyword
// result is returned. The keyword list is intentionally limited to the contract's example phrases; the AI
// classifier handles everything else (paraphrases, other languages, context).
import { AI_TIMEOUT_MS } from './config.ts'
import { MODELS } from './models.ts'
import { OpenAIError, responsesJson, type InputContent } from './openai.ts'
import type { AiMeta } from './types.ts'

export type ThreatLevel = 'none' | 'possible' | 'high'

export interface ThreatResult {
  threat_level: ThreatLevel
  phrases: string[]
  reason_en: string
  reason_ur: string
  /** which pass decided the level */
  source: 'keyword' | 'ai' | 'none'
  keyword_hits: string[]
  meta: AiMeta | null
  ai_error?: string
}

const RANK: Record<ThreatLevel, number> = { none: 0, possible: 1, high: 2 }
export function maxThreat(a: ThreatLevel, b: ThreatLevel): ThreatLevel {
  return RANK[b] > RANK[a] ? b : a
}
export function isThreatLevel(v: unknown): v is ThreatLevel {
  return v === 'none' || v === 'possible' || v === 'high'
}

// ---------------------------------------------------------------- normalisation

/**
 * Fold spelling variants so one pattern matches many STT outputs: Arabic-script letter variants (yeh, kaf, heh,
 * hamza forms, noon ghunna), diacritics, tatweel, zero-width marks; Devanagari nukta / candrabindu; lowercase Latin.
 */
export function normalizeForMatch(s: string): string {
  return foldWithMap(s).text
}

const DROP = /[​-‏‪-‮⁦-⁩ـً-ٰٟۖ-़ۭ]/
const FOLD: Record<string, string> = {
  'ي': 'ی', 'ى': 'ی', 'ے': 'ی', 'ۓ': 'ی', 'ئ': 'ی', // yeh forms -> ی
  'ك': 'ک', // Arabic kaf -> ک
  'ه': 'ہ', 'ھ': 'ہ', 'ۂ': 'ہ', 'ۃ': 'ہ', // heh forms -> ہ
  'ؤ': 'و', // ؤ -> و
  'آ': 'ا', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا', // alef forms -> ا
  'ں': 'ن', // ں -> ن
  'ँ': 'ं', // candrabindu -> anusvara
  '’': "'", '‘': "'", '`': "'", '´': "'",
}

/** Fold `s` and keep, per output UTF-16 unit, the [start, end) span of the source character it came from. */
function foldWithMap(s: string): { text: string; src: string; spans: [number, number][] } {
  const src = (s ?? '').normalize('NFC')
  let text = ''
  const spans: [number, number][] = []
  let i = 0
  for (const ch of src) {
    const start = i
    i += ch.length
    if (DROP.test(ch)) continue
    if (/\s/.test(ch)) {
      if (!text || text.endsWith(' ')) continue
      text += ' '
      spans.push([start, i])
      continue
    }
    const out = (FOLD[ch] ?? ch).toLowerCase()
    for (let k = 0; k < out.length; k++) spans.push([start, i])
    text += out
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    spans.pop()
  }
  return { text, src, spans }
}

// ---------------------------------------------------------------- deterministic pass

interface KeywordRule { id: string; re: RegExp }

/** Build a rule; Arabic-script / Devanagari letters in the source are folded like the text (regex syntax untouched). */
function rule(id: string, source: string): KeywordRule {
  let folded = ''
  for (const ch of source.normalize('NFC')) {
    if (DROP.test(ch)) continue
    folded += ch.charCodeAt(0) < 0x80 ? ch : (FOLD[ch] ?? ch)
  }
  return { id, re: new RegExp(folded, 'iu') }
}

// Contract / brief examples only (Urdu script, Roman Urdu, Punjabi, English, Hindi-script STT output).
const HIGH_RULES: KeywordRule[] = [
  // Roman Urdu / Punjabi
  rule('maar_dunga', String.raw`\bmaa?r\s*d(?:u|oo)n?\s*g[aie]\b`),
  rule('jaan_se_maar', String.raw`\bjaa?n\s*(?:se|say|sey|ton|to)\s*maa?r`),
  rule('qatal', String.raw`\bqa+ta?l\b`),
  rule('chaqu_chhuri', String.raw`\b(?:cha+q+u+|chh?u+r+i)\b`),
  rule('goli_maar', String.raw`\bgoli\s*maa?r`),
  rule('utha_le_ja', String.raw`\butha\s*(?:ke|kar|k)\s*(?:le|lay)\s*ja`),
  rule('chhor_do', String.raw`\bchh?o+[rd]\s*d[oe]\b`),
  rule('bachao', String.raw`\bbacha+o+\b`),
  rule('madad_karo', String.raw`\bmadad\s*kar[oeiy]`),
  // English
  rule('help_me', String.raw`\bhelp\s+me\b`),
  rule('let_me_go', String.raw`\blet\s+me\s+go\b`),
  rule('kill_you', String.raw`\b(?:i'?ll|i\s+will)\s+kill\s+you\b`),
  rule('dont_touch_me', String.raw`\b(?:don'?t|do\s+not)\s+touch\s+me\b`),
  rule('stop_hitting', String.raw`\bstop\s+hitting\b`),
  // Urdu script (folded by normalizeForMatch)
  rule('ur_maar_dunga', 'مار\\s*دوں\\s*گ[اےی]'),
  rule('ur_jaan_se_maar', 'جان\\s*سے\\s*مار'),
  rule('ur_qatal', 'قتل'),
  rule('ur_chaqu_chhuri', 'چاقو|چھری'),
  rule('ur_goli_maar', 'گولی\\s*مار'),
  rule('ur_utha_le_ja', 'اٹھا\\s*(?:کر|کے)\\s*لے\\s*جا'),
  rule('ur_chhor_do', 'چھوڑ\\s*دو'),
  rule('ur_bachao', 'بچاؤ'),
  rule('ur_madad_karo', 'مدد\\s*کر'),
  // Hindi-script STT output of the same Urdu phrases
  rule('hi_bachao', 'बचाओ'),
  rule('hi_chhor_do', 'छोड़\\s*दो'),
  rule('hi_jaan_se_maar', 'जान\\s*से\\s*मार'),
  rule('hi_madad', 'मदद\\s*कर'),
  // transcription sound markers for screaming
  rule('scream_marker', String.raw`[\[(*]\s*(?:screams?|screaming|shouting|yelling|crying|چیخ\S*)\s*[\])*]`),
]

/** Deterministic pass: any hit ⇒ 'high'. Returns the matched text snippets (original casing where possible). */
export function keywordThreat(windowText: string): { level: ThreatLevel; phrases: string[]; hits: string[] } {
  const { text: norm, src, spans } = foldWithMap(windowText)
  if (!norm) return { level: 'none', phrases: [], hits: [] }
  const phrases: string[] = []
  const hits: string[] = []
  for (const r of HIGH_RULES) {
    const m = r.re.exec(norm)
    if (!m || !m[0]) continue
    hits.push(r.id)
    const a = spans[m.index]
    const b = spans[m.index + m[0].length - 1]
    const p = (a && b ? src.slice(a[0], b[1]) : m[0]).replace(/\s+/g, ' ').trim()
    if (p && !phrases.includes(p)) phrases.push(p)
  }
  return { level: hits.length ? 'high' : 'none', phrases: phrases.slice(0, 8), hits }
}

// ---------------------------------------------------------------- AI pass

const THREAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['threat_level', 'phrases', 'reason_en', 'reason_ur'],
  properties: {
    threat_level: { type: 'string', enum: ['none', 'possible', 'high'] },
    phrases: { type: 'array', items: { type: 'string' }, description: 'up to 5 short exact quotes from the transcript' },
    reason_en: { type: 'string', description: 'one short English sentence, at most 20 words' },
    reason_ur: { type: 'string', description: 'the same sentence in Urdu script, at most 20 words' },
  },
}

const THREAT_INSTRUCTIONS = `You are the safety monitor of Awaaz SOS (Islamabad / Rawalpindi, Pakistan). A person — usually a woman — pressed SOS on her phone; the app is quietly recording the surroundings. You get the speech-to-text transcript of the last ~30 seconds. It may be Urdu script, Roman Urdu, Punjabi, English, Hindi-script output of Urdu speech, or a mix, and it is noisy (misspellings, fragments, sound markers in brackets).
Decide whether the person may be in danger right now. Return JSON matching the schema.
- "high": a clear indicator that someone is threatening or harming the person: threats to kill or hurt, a weapon mentioned, forcing her to go somewhere, assault or harassment in progress, or the person pleading to be released or for help, or screaming.
- "possible": signs of distress without a clear threat: an angry or intimidating voice, an argument escalating, being followed, crying, ambiguous pleading.
- "none": ordinary conversation, silence, TV / music, traffic, or nothing relevant.
Safety first: if torn between "none" and "possible", choose "possible". Use "high" only when there is a concrete indicator in the text.
phrases: up to 5 short exact quotes from the transcript (original script) that support the level; [] for "none". Never invent words that are not in the transcript.
reason_en: one plain sentence (at most 20 words) a police officer can read quickly. reason_ur: the same in simple Urdu script.`

const AI_TIMEOUT = Math.min(AI_TIMEOUT_MS.verify, 9000)

function clean(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

async function aiThreat(windowText: string, lang: string | undefined): Promise<{
  level: ThreatLevel; phrases: string[]; reason_en: string; reason_ur: string; meta: AiMeta
}> {
  const content: InputContent[] = [{
    type: 'input_text',
    text: `Detected language: ${lang || 'unknown'}\nTranscript (oldest first):\n"""${windowText.slice(-3000)}"""`,
  }]
  const models = [MODELS.reason.primary, MODELS.reason.fallback]
  const t0 = Date.now()
  let lastErr: unknown
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    if (i > 0 && model === models[0]) break
    try {
      const { data } = await responsesJson<{ threat_level?: unknown; phrases?: unknown; reason_en?: unknown; reason_ur?: unknown }>(
        model, THREAT_INSTRUCTIONS, content, 'threat_check', THREAT_SCHEMA,
        { timeoutMs: AI_TIMEOUT, label: `threat:${model}`, maxOutputTokens: 1200, effort: 'low' },
      )
      if (!isThreatLevel(data?.threat_level)) throw new Error('threat_level missing')
      const phrases = Array.isArray(data.phrases) ? data.phrases.map((p) => clean(p, 120)).filter(Boolean).slice(0, 5) : []
      const reason_en = clean(data.reason_en)
      return {
        level: data.threat_level,
        phrases,
        reason_en,
        reason_ur: clean(data.reason_ur) || reason_en,
        meta: { provider: 'openai', model, fallback: i > 0, ms: Date.now() - t0 },
      }
    } catch (e) {
      lastErr = e
      if (e instanceof OpenAIError && e.fatal) break
      // GEMINI_FALLBACK_HOOK: a third-tier Gemini classifier would plug in here (not wired — OpenAI only).
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Deterministic bilingual reason for a keyword hit (used for the fast escalation path). */
export function keywordReason(phrases: string[]): { en: string; ur: string } {
  const q = phrases.slice(0, 3).map((p) => `“${p}”`).join(', ')
  return {
    en: `Distress or threat words heard: ${q}.`,
    ur: `خطرے یا مدد کی پکار کے الفاظ سنے گئے: ${q}۔`,
  }
}

/**
 * Classify the recent transcript window. Keyword hits force 'high'; the AI may raise none → possible/high but
 * never lowers a keyword 'high'. `opts.skipAi` returns the keyword result only (used when the window has no new
 * words). Never throws.
 */
export async function threatCheck(
  windowText: string,
  lang?: string,
  opts: { skipAi?: boolean } = {},
): Promise<ThreatResult> {
  const text = (windowText ?? '').trim()
  const kw = keywordThreat(text)
  const base: ThreatResult = kw.level === 'high'
    ? { threat_level: 'high', phrases: kw.phrases, ...pick(keywordReason(kw.phrases)), source: 'keyword', keyword_hits: kw.hits, meta: null }
    : { threat_level: 'none', phrases: [], reason_en: '', reason_ur: '', source: 'none', keyword_hits: [], meta: null }
  if (!text || opts.skipAi) return base
  try {
    const ai = await aiThreat(text, lang)
    const level = maxThreat(base.threat_level, ai.level)
    const phrases = [...new Set([...kw.phrases, ...ai.phrases])].slice(0, 8)
    const useAiReason = Boolean(ai.reason_en) && ai.level !== 'none'
    return {
      threat_level: level,
      phrases,
      reason_en: useAiReason ? ai.reason_en : base.reason_en,
      reason_ur: useAiReason ? ai.reason_ur : base.reason_ur,
      source: kw.level === 'high' ? 'keyword' : ai.level === 'none' ? 'none' : 'ai',
      keyword_hits: kw.hits,
      meta: ai.meta,
    }
  } catch (e) {
    console.warn('[threat] AI check failed, keyword result used:', e instanceof Error ? e.message : e)
    return { ...base, ai_error: e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}

function pick(r: { en: string; ur: string }): { reason_en: string; reason_ur: string } {
  return { reason_en: r.en, reason_ur: r.ur }
}
