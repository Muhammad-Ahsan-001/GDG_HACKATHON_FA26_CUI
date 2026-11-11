// The ONLY module other Edge Function code uses for AI (docs/CONTRACT.md §2).
// Every task runs on OpenAI: MODELS.<task>.primary, then MODELS.<task>.fallback on failure / timeout / invalid output.
// Prompts are tuned for Islamabad / Rawalpindi: Urdu script, Roman Urdu, Punjabi, English and code-switching.

import { MODELS } from './models.ts'
import { AI_TIMEOUT_MS, FOOD_DEFAULT_SAFE_HOURS } from './config.ts'
import { embeddings, OpenAIError, responsesJson, speech, transcription, type InputContent } from './openai.ts'
import {
  CATEGORIES,
  URGENCIES,
  type AiMeta,
  type Category,
  type DigestPin,
  type Extraction,
  type PhotoCheck,
  type Urgency,
  type VerificationInput,
} from './types.ts'

export type { AiMeta, DigestPin, Extraction, PhotoCheck, Provider, VerificationInput } from './types.ts'

/** Thrown when both the primary and the fallback model failed for a task. */
export class AiError extends Error {
  task: string
  constructor(task: string, message: string) {
    super(`ai ${task}: ${message}`)
    this.name = 'AiError'
    this.task = task
  }
}

// ======================================================================= shared fallback helper

interface TaskModels { primary: string; fallback: string }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Run `run(model, isFallback)` on the task's primary OpenAI model; on any error (timeout, 429/5xx after the
 * low-level retry, refusal, truncated or invalid JSON, failed validation) run it again on the fallback model.
 */
async function withFallback<T>(
  task: string,
  models: TaskModels,
  run: (model: string, isFallback: boolean) => Promise<T>,
): Promise<{ value: T; meta: AiMeta }> {
  const t0 = Date.now()
  let firstError: unknown
  try {
    const value = await run(models.primary, false)
    return { value, meta: { provider: 'openai', model: models.primary, fallback: false, ms: Date.now() - t0 } }
  } catch (e) {
    firstError = e
  }
  const fatal = firstError instanceof OpenAIError && firstError.fatal
  const sameModelBadRequest = models.fallback === models.primary && firstError instanceof OpenAIError && firstError.status === 400
  if (!fatal && !sameModelBadRequest) {
    console.warn(`[ai] ${task}: ${models.primary} failed (${errText(firstError)}) -> fallback ${models.fallback}`)
    try {
      const value = await run(models.fallback, true)
      return { value, meta: { provider: 'openai', model: models.fallback, fallback: true, ms: Date.now() - t0 } }
    } catch (e2) {
      // GEMINI_FALLBACK_HOOK: this is the single place a third-tier Gemini fallback plugs in (not wired by user
      // decision — OpenAI only for now). When enabled: if Deno.env GEMINI_API_KEY is set, call a `_shared/gemini.ts`
      // adapter with MODELS.<task>.gemini (same instructions + JSON schema via generationConfig.responseJsonSchema,
      // audio/images as inline_data, embeddings via gemini-embedding-001 outputDimensionality 1536) and return
      // meta { provider: 'gemini', model: MODELS.<task>.gemini, fallback: true }. The `fatal` branch above (bad or
      // missing OpenAI key) should also route here instead of throwing. Embedding vectors from Gemini must be stored
      // with their own embedding_model (never compared with OpenAI vectors).
      throw new AiError(task, `${models.primary}: ${errText(firstError)} | ${models.fallback}: ${errText(e2)}`)
    }
  }
  throw new AiError(task, `${models.primary}: ${errText(firstError)}`)
}

// ======================================================================= small helpers

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/
const ROMAN_URDU = /\b(hai|hain|ho|nahi|nahin|nai|mein|main|mai|ka|ki|ke|ko|se|aur|yahan|wahan|bahar|paas|bhai|kya|raha|rahi|rahe|gaya|gayi|gai|hua|hui|hoa|kar|karo|karein|jaldi|log|logon|bacha|bachay|pani|bijli|aag|sarak|gali)\b/gi

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : fallback
}

function capWords(s: string, max: number, ellipsis = false): string {
  const words = s.split(/\s+/).filter(Boolean)
  if (words.length <= max) return words.join(' ')
  return words.slice(0, max).join(' ').replace(/[,;:\-–—]+$/, '') + (ellipsis ? '…' : '')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as string[]).includes(v)
}

function isUrgency(v: unknown): v is Urgency {
  return typeof v === 'string' && (URGENCIES as string[]).includes(v)
}

function hasUrdu(s: string): boolean {
  return ARABIC_SCRIPT.test(s)
}

/** Deterministic clean-up so equivalent canonical strings converge exactly. */
export function normalizeCanonical(s: string): string {
  let c = s.toLowerCase()
  c = c.replace(/[“”"'`’]/g, '')
  c = c.replace(/\b(?:street|st|gali|galli)\.?\s*(?:no\.?|number|#)?\s*(?=\d)/g, 'street ')
  c = c.replace(/\b(?:a|an|the)\s+(?=[a-z0-9])/g, '')
  c = c.replace(/\b(?:islamabad|rawalpindi)\b/g, ' ')
  c = c.replace(/\s*,\s*/g, ', ').replace(/(,\s*)+/g, ', ')
  c = c.replace(/\s+/g, ' ').trim()
  c = c.replace(/^[,.\s]+|[,.;:!?\s]+$/g, '')
  return c
}

// ======================================================================= transcribe

const STT_KEYWORDS = [
  'Islamabad', 'Rawalpindi', 'G-9', 'G-10', 'G-11', 'G-6', 'F-6', 'F-7', 'F-8', 'F-10', 'F-11', 'I-8', 'I-9', 'I-10',
  'E-11', 'H-8', 'Blue Area', 'Saddar', 'Raja Bazaar', 'Committee Chowk', 'Faizabad', 'Murree Road', 'Satellite Town',
  'Bahria Town', 'DHA', 'Chandni Chowk', 'Peshawar Mor', 'Zero Point', 'Markaz', 'Nullah Leh', 'Rescue 1122',
  'gutter', 'manhole', 'nala', 'WASA', 'CDA', 'IESCO',
]

const STT_FALLBACK_PROMPT =
  'Islamabad, Rawalpindi, G-9, F-7, I-8, Saddar, Committee Chowk, Rescue 1122, gutter, manhole, nala, WASA, CDA.'

function langOrder(hint?: 'ur' | 'en' | 'pa' | 'auto'): string[] {
  const base = ['ur', 'pa', 'en']
  if (!hint || hint === 'auto') return base
  return [hint, ...base.filter((l) => l !== hint)]
}

function detectLanguage(codes: string[], text: string, hint?: string): 'ur' | 'pa' | 'en' | 'mixed' {
  const known = new Set<'ur' | 'pa' | 'en'>()
  for (const c of codes) {
    if (c.startsWith('ur') || c.startsWith('hi')) known.add('ur') // Urdu speech is often tagged as Hindi
    else if (c.startsWith('pa') || c.startsWith('pnb')) known.add('pa')
    else if (c.startsWith('en')) known.add('en')
  }
  if (known.size > 1) return 'mixed'
  if (known.size === 1) return [...known][0]
  const t = text.trim()
  if (!t) return hint === 'en' || hint === 'pa' ? hint : 'ur'
  const latinWords = (t.match(/\b[a-z]{2,}\b/gi) ?? []).length
  if (hasUrdu(t)) return latinWords >= 3 ? 'mixed' : 'ur'
  const romanUrdu = (t.match(ROMAN_URDU) ?? []).length
  if (romanUrdu >= 2) return romanUrdu / Math.max(latinWords, 1) > 0.25 ? 'ur' : 'mixed'
  return 'en'
}

export async function transcribe(
  audio: Uint8Array,
  mime: string,
  hintLang?: 'ur' | 'en' | 'pa' | 'auto',
): Promise<{ text: string; language: string; meta: AiMeta }> {
  if (!audio?.byteLength) throw new AiError('transcribe', 'empty audio')
  const { value, meta } = await withFallback('transcribe', MODELS.stt, async (model, isFallback) => {
    const opts = { timeoutMs: AI_TIMEOUT_MS.transcribe, label: `transcribe:${model}` }
    if (isFallback || !model.startsWith('gpt-transcribe')) {
      // older single-language models: let them auto-detect, bias vocabulary via prompt
      return await transcription(model, audio, mime, { prompt: STT_FALLBACK_PROMPT }, opts)
    }
    let languages = langOrder(hintLang)
    let keywords: string[] | undefined = STT_KEYWORDS
    for (let attempt = 0; ; attempt++) {
      try {
        return await transcription(model, audio, mime, { languages, keywords }, opts)
      } catch (e) {
        if (!(e instanceof OpenAIError) || e.status !== 400 || attempt >= 2) throw e
        if (/language/i.test(e.message) && languages.includes('pa')) languages = languages.filter((l) => l !== 'pa')
        else if (/keyword/i.test(e.message) && keywords) keywords = undefined
        else throw e
      }
    }
  })
  return { text: value.text, language: detectLanguage(value.languages, value.text, hintLang), meta }
}

// ======================================================================= extractReport

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'language', 'is_spam', 'spam_reason', 'category', 'urgency', 'location_hints', 'title_en', 'title_ur',
    'summary_en', 'summary_ur', 'canonical_en', 'food', 'confidence_notes',
  ],
  properties: {
    language: { type: 'string', enum: ['ur', 'pa', 'en', 'mixed'] },
    is_spam: { type: 'boolean' },
    spam_reason: { type: ['string', 'null'] },
    category: { type: 'string', enum: CATEGORIES },
    urgency: { type: 'string', enum: URGENCIES },
    location_hints: { type: 'array', items: { type: 'string' } },
    title_en: { type: 'string', description: 'English headline, at most 8 words' },
    title_ur: { type: 'string', description: 'Urdu-script headline, at most 8 words' },
    summary_en: { type: 'string', description: '1-2 short English sentences' },
    summary_ur: { type: 'string', description: '1-2 short sentences in Urdu script' },
    canonical_en: { type: 'string', description: 'normalised lowercase dedup key' },
    food: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['food_type', 'servings_estimate', 'safe_hours'],
          properties: {
            food_type: { type: 'string' },
            servings_estimate: { type: 'integer' },
            safe_hours: { type: 'number' },
          },
        },
        { type: 'null' },
      ],
    },
    confidence_notes: { type: 'string' },
  },
}

const EXTRACT_INSTRUCTIONS = `You are the intake analyst for Awaaz, a civic-issue reporting service for Islamabad and Rawalpindi, Pakistan.
Citizens (many cannot read or write) report local problems by voice note (already transcribed for you), typed text, or photo.
Turn ONE report into ONE JSON object that matches the schema exactly.

INPUT LANGUAGE
- Reports come in Urdu script, Roman Urdu (Urdu in English letters, e.g. "pani nahi aa raha"), Punjabi / Pothwari (Shahmukhi or Roman), English, or a code-switched mix. Speech-to-text output can be noisy: misspellings, no punctuation, Hindi-style spellings, repeated words. Infer the intended meaning.
- Vocabulary: gutter / gattar = sewer manhole; "gutter khula" / "dhakkan nahi" = open manhole; nala / nullah = storm drain or stream; bijli = electricity; taar = wire; pani = water; aag = fire; dhuan = smoke; khana / dawat / shadi ka khana = food; deg = big cooking pot (about 50 servings); sarak / road toot gayi = broken road; deewar giri = wall collapsed; chori / dakaiti / mobile cheena = theft / robbery / snatching; tang karna / chherna = harassment; behosh = unconscious; zakhmi = injured; machar / dengue = mosquitoes; Rescue 1122 = emergency service; WASA / CDA / IESCO = water / civic / electricity authorities; G-9/4, F-7 Markaz, I-8, Saddar, Committee Chowk, Raja Bazaar etc. are places.
- "language" = main language of the citizen's own words: "ur" (Urdu in any script, including Roman Urdu), "pa" (Punjabi / Pothwari), "en" (English), "mixed" (real code-switching, e.g. half English, half Urdu clauses). English loanwords (road, school, gutter, light, street) inside Urdu do NOT make it mixed.

CATEGORY (exactly one — the one a responder would act on)
- hazard: physical danger in a public place — open manhole / gutter, uncovered drain, live or fallen electric wire, sparking pole or transformer, broken or caved-in road, deep pothole, collapsed or leaning wall, fallen tree, broken traffic signal, dangerous construction debris.
- fire: any fire or smoke from a fire, gas cylinder fire, burning garbage, short-circuit fire.
- flood: waterlogging, flooded street or underpass, nala / nullah overflow, rain water entering homes, people or cars stuck in water.
- water: drinking-water supply cut or low pressure, dirty / smelly / contaminated tap water, burst or leaking water pipe, sewage mixing into the water line.
- food: surplus food available to donate (wedding, event, restaurant, caterer) OR people in hunger / food need.
- health: medical emergency, injured or unconscious person, accident victims, dengue / mosquito breeding, disease outbreak, someone needing an ambulance or urgent medicine.
- safety: crime, theft, snatching, harassment, violence, fights, threats, suspicious activity, missing child.
- other: a genuine local civic issue that fits none of the above (garbage not collected, streetlight off, stray dogs, encroachment, noise).
If the app gives a category hint (the icon the user tapped), use it when plausible; override it when the words clearly say otherwise.

URGENCY
- critical: immediate danger to life right now — fire, live / sparking wire on the ground or in water, someone drowning or trapped in flood water, building or wall collapse with people possibly under it, unconscious or not-breathing person, serious accident with injuries, armed violence in progress.
- high: serious hazard likely to injure someone soon, or affecting many people — open manhole near a school / market / busy road, flooded main road, big water-main burst, gas smell, missing child, ongoing harassment at a spot, dengue cluster.
- medium: real problem needing action within a day — water supply cut, contaminated tap water, broken road without immediate danger, surplus food to collect within hours, theft that already happened.
- low: inconvenience or slow problem — garbage pile, streetlight off, small leak, stray animals, small pothole.
Choose the higher level only when life or limb is at risk.

FIELDS
- title_en / title_ur: at most 8 words each, a headline naming the issue and place. title_ur in Urdu script (never Roman Urdu).
- summary_en / summary_ur: 1-2 short, plain sentences: what, where, why it matters. summary_ur MUST be Urdu script with simple everyday words. Never invent facts that are not in the report.
- canonical_en: a normalised English key used to detect duplicate reports of the SAME incident across languages and wordings. Rules:
  * Template: "<core issue noun phrase> near|at <landmark>, <street>, <sector or area>". Drop parts that are not mentioned (never write "unknown").
  * Lowercase. No articles (a, an, the). No verbs or filler ("there is", "please", "is open"). No time words (today, since morning). No people counts, opinions or reporter details. No city names (islamabad, rawalpindi).
  * Use the standard issue noun: "open manhole" (gutter khula, uncovered sewer, missing manhole cover), "live electric wire", "broken road", "pothole", "collapsed wall", "fallen tree", "broken traffic signal", "fire", "waterlogging", "nala overflow", "water supply cut", "contaminated water", "water pipe leak", "surplus food", "food need", "medical emergency", "injured person", "dengue mosquitoes", "theft", "harassment", "garbage pile".
  * "near" for proximity (ke bahar, ke paas, ke samne, outside, next to, opposite); "at" for exactly at / inside.
  * Places in English nouns even when the report is Urdu: "street 5" (not st. 5 / gali 5 / street no. 5), school, mosque (masjid), market (bazaar), hospital, park, chowk; sector codes like "g-9/4", "f-7 markaz".
  * Order: landmark, then street, then sector / area.
  Two people describing the same thing in different words or languages MUST produce the same canonical_en.
- location_hints: every place clue for geocoding, most specific first: house / street numbers, landmarks, sector or area, city (e.g. ["Street 5", "school", "G-9/4", "Islamabad"]). Include the typed address if given. Empty array if none.
- is_spam / spam_reason: is_spam = true for jokes, pranks, insults or abuse, advertisements, gibberish, test messages, or anything that is not a real local issue (political opinion, national news, personal chat). spam_reason = short English reason, else null. A real issue told angrily or rudely is NOT spam; short or vague but plausible reports are NOT spam. For spam use category "other", urgency "low", food null.
- food: ONLY for category "food" when food is on offer: food_type (short English, e.g. "biryani and naan"), servings_estimate (integer number of people it can feed; use the stated number; 1 deg ≈ 50, 1 tray ≈ 10), safe_hours (hours it stays safe: cooked rice / meat / curry at room temperature ≈ 4, bread / dry items ≈ 8, packaged ≈ 24; less in hot weather). For a hunger need or any other category: null.
- confidence_notes: one short English line on what is uncertain (vague location, ambiguous category, noisy transcript) or "clear".

EXAMPLES
Input: Voice note transcript: """Street 5 ke school ke bahar gutter khula hai"""
Output: {"language":"ur","is_spam":false,"spam_reason":null,"category":"hazard","urgency":"high","location_hints":["Street 5","school"],"title_en":"Open manhole outside Street 5 school","title_ur":"گلی 5 کے اسکول کے باہر کھلا گٹر","summary_en":"A manhole outside the school on Street 5 has no cover. Children could fall in.","summary_ur":"گلی نمبر 5 میں اسکول کے باہر گٹر کھلا ہے۔ بچے گر سکتے ہیں۔","canonical_en":"open manhole near school, street 5","food":null,"confidence_notes":"sector not mentioned"}

Input: Typed text: """open manhole near the school on Street 5"""
Output: {"language":"en","is_spam":false,"spam_reason":null,"category":"hazard","urgency":"high","location_hints":["Street 5","school"],"title_en":"Open manhole near Street 5 school","title_ur":"گلی 5 کے اسکول کے پاس کھلا گٹر","summary_en":"There is an open manhole near the school on Street 5, a danger to children and passers-by.","summary_ur":"گلی نمبر 5 پر اسکول کے پاس گٹر کھلا ہے، بچوں اور راہگیروں کے لیے خطرہ ہے۔","canonical_en":"open manhole near school, street 5","food":null,"confidence_notes":"sector not mentioned"}

Input: Voice note transcript: """Assalam o alaikum hum caterer hain, shadi ka khana bach gaya hai, biryani aur qorma, takreeban 120 logon ka, F-10 Markaz ke Al Noor marquee pe hai, koi NGO utha le"""
Output: {"language":"ur","is_spam":false,"spam_reason":null,"category":"food","urgency":"medium","location_hints":["Al Noor marquee","F-10 Markaz","Islamabad"],"title_en":"Wedding food for 120 at Al Noor marquee","title_ur":"النور مارکی میں 120 افراد کا شادی کا کھانا","summary_en":"A caterer has leftover wedding biryani and qorma for about 120 people at Al Noor marquee, F-10 Markaz, ready for pickup.","summary_ur":"ایف ٹین مرکز کے النور مارکی میں تقریباً 120 لوگوں کے لیے شادی کا بچا ہوا بریانی اور قورمہ موجود ہے۔","canonical_en":"surplus food at al noor marquee, f-10 markaz","food":{"food_type":"biryani and qorma","servings_estimate":120,"safe_hours":4},"confidence_notes":"clear"}

Input: Typed text: """hahaha mera dost Bilal gadha hai isko pakar lo police wale"""
Output: {"language":"ur","is_spam":true,"spam_reason":"joke insulting a friend, not a civic issue","category":"other","urgency":"low","location_hints":[],"title_en":"Joke message about a friend","title_ur":"دوست کے بارے میں مذاق","summary_en":"A joke about a friend, not a real local problem.","summary_ur":"یہ دوست کے بارے میں مذاق ہے، کوئی اصل مسئلہ نہیں۔","canonical_en":"joke message","food":null,"confidence_notes":"clear"}

Input: Voice note transcript: """جی نائن مرکز میں کپڑوں کی دکان میں آگ لگ گئی ہے بہت دھواں ہے جلدی 1122 بھیجیں"""
Output: {"language":"ur","is_spam":false,"spam_reason":null,"category":"fire","urgency":"critical","location_hints":["clothing shop","G-9 Markaz","Islamabad"],"title_en":"Fire in clothing shop, G-9 Markaz","title_ur":"جی نائن مرکز میں کپڑوں کی دکان میں آگ","summary_en":"A clothing shop in G-9 Markaz is on fire with heavy smoke. Rescue 1122 is needed urgently.","summary_ur":"جی نائن مرکز میں کپڑوں کی دکان میں آگ لگی ہے اور بہت دھواں ہے۔ فوری طور پر 1122 کی ضرورت ہے۔","canonical_en":"fire at clothing shop, g-9 markaz","food":null,"confidence_notes":"clear"}

Input: Voice note transcript: """bhai Nullah Leh overflow ho gaya hai near Committee Chowk, do gaariyan phans gayi hain pani mein"""
Output: {"language":"mixed","is_spam":false,"spam_reason":null,"category":"flood","urgency":"critical","location_hints":["Nullah Leh","Committee Chowk","Rawalpindi"],"title_en":"Nullah Leh overflowing, cars stuck near Committee Chowk","title_ur":"کمیٹی چوک کے پاس نالہ لئی ابل پڑا","summary_en":"Nullah Leh has overflowed near Committee Chowk and two cars are stuck in the water. People may be trapped.","summary_ur":"کمیٹی چوک کے پاس نالہ لئی کا پانی سڑک پر آ گیا ہے اور دو گاڑیاں پانی میں پھنس گئی ہیں۔","canonical_en":"nala overflow near committee chowk, nullah leh","food":null,"confidence_notes":"clear"}

Input: Typed text: """I-8/3 mein teen din se pani nahi aa raha"""
Output: {"language":"ur","is_spam":false,"spam_reason":null,"category":"water","urgency":"medium","location_hints":["I-8/3","Islamabad"],"title_en":"No water supply for three days in I-8/3","title_ur":"آئی ایٹ تھری میں تین دن سے پانی بند","summary_en":"Residents of I-8/3 have had no water supply for three days.","summary_ur":"آئی ایٹ تھری میں تین دن سے پانی نہیں آ رہا۔","canonical_en":"water supply cut, i-8/3","food":null,"confidence_notes":"clear"}`

function buildExtractInput(input: {
  text?: string
  transcript?: string
  uiLanguage: 'ur' | 'en'
  addressText?: string
  categoryHint?: string
}): string {
  const lines: string[] = []
  lines.push(`App language of the user: ${input.uiLanguage === 'ur' ? 'Urdu' : 'English'}`)
  if (input.categoryHint && isCategory(input.categoryHint)) lines.push(`Category hint (icon the user tapped): ${input.categoryHint}`)
  const addr = str(input.addressText)
  if (addr) lines.push(`Typed address / landmark: """${addr.slice(0, 300)}"""`)
  const transcript = str(input.transcript)
  const text = str(input.text)
  if (transcript) lines.push(`Voice note transcript (speech-to-text, may be noisy): """${transcript.slice(0, 4000)}"""`)
  if (text) lines.push(`Typed text: """${text.slice(0, 4000)}"""`)
  if (!transcript && !text) {
    lines.push('No words were given (photo-only report). Use the category hint if any, otherwise "other"; describe it as a reported issue needing a look. Do NOT mark it as spam only because it is empty.')
  }
  return lines.join('\n')
}

function sanitizeExtraction(raw: unknown, categoryHint: string | undefined, strict: boolean): Extraction {
  if (!raw || typeof raw !== 'object') throw new Error('extraction is not an object')
  const r = raw as Record<string, unknown>
  const is_spam = r.is_spam === true
  const category: Category = isCategory(r.category) ? r.category : isCategory(categoryHint) ? categoryHint : 'other'
  const urgency: Urgency = isUrgency(r.urgency) ? r.urgency : 'medium'
  let title_en = capWords(str(r.title_en), 8)
  let title_ur = capWords(str(r.title_ur), 8)
  const summary_en = str(r.summary_en)
  const summary_ur = str(r.summary_ur)
  if (!title_en && !summary_en) throw new Error('extraction has no title or summary')
  if (strict && !is_spam && !hasUrdu(title_ur + summary_ur)) throw new Error('extraction Urdu fields are not in Urdu script')
  if (!title_en) title_en = capWords(summary_en, 8)
  if (!title_ur) title_ur = capWords(summary_ur, 8) || title_en
  const canonical_en = normalizeCanonical(str(r.canonical_en) || title_en)
  if (!canonical_en) throw new Error('extraction has no canonical_en')
  const hints = Array.isArray(r.location_hints)
    ? [...new Set(r.location_hints.map((h) => str(h)).filter(Boolean))].slice(0, 8)
    : []
  const language = r.language === 'ur' || r.language === 'pa' || r.language === 'en' || r.language === 'mixed' ? r.language : 'ur'

  let food: Extraction['food'] = null
  if (category === 'food' && !is_spam && r.food && typeof r.food === 'object') {
    const f = r.food as Record<string, unknown>
    const servings = Number(f.servings_estimate)
    const hours = Number(f.safe_hours)
    food = {
      food_type: str(f.food_type) || 'cooked food',
      servings_estimate: Number.isFinite(servings) ? Math.round(clamp(servings, 0, 100000)) : 0,
      safe_hours: Number.isFinite(hours) && hours > 0 ? clamp(hours, 0.5, 72) : FOOD_DEFAULT_SAFE_HOURS,
    }
  }

  return {
    category,
    urgency,
    title_en,
    title_ur,
    summary_en: summary_en || title_en,
    summary_ur: summary_ur || title_ur,
    canonical_en,
    location_hints: hints,
    language,
    is_spam,
    spam_reason: is_spam ? (str(r.spam_reason) || 'not a local civic issue') : null,
    food,
    confidence_notes: str(r.confidence_notes) || 'clear',
  }
}

export async function extractReport(input: {
  text?: string
  transcript?: string
  uiLanguage: 'ur' | 'en'
  addressText?: string
  categoryHint?: string
}): Promise<{ data: Extraction; meta: AiMeta }> {
  const content: InputContent[] = [{ type: 'input_text', text: buildExtractInput(input) }]
  const { value, meta } = await withFallback('extract', MODELS.extract, async (model, isFallback) => {
    const { data } = await responsesJson(model, EXTRACT_INSTRUCTIONS, content, 'report_extraction', EXTRACTION_SCHEMA, {
      timeoutMs: AI_TIMEOUT_MS.extract,
      label: `extract:${model}`,
      maxOutputTokens: 4000,
    })
    return sanitizeExtraction(data, input.categoryHint, !isFallback)
  })
  return { data: value, meta }
}

// ======================================================================= checkPhoto

const PHOTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes', 'matches_claim', 'severity', 'food_type', 'servings_estimate'],
  properties: {
    notes: { type: 'string', description: 'one or two short English sentences on what the photo shows' },
    matches_claim: { type: 'boolean' },
    severity: { type: 'string', enum: URGENCIES },
    food_type: { type: ['string', 'null'] },
    servings_estimate: { type: ['integer', 'null'] },
  },
}

const PHOTO_INSTRUCTIONS = `You check citizen photos for Awaaz, a civic-issue reporting service in Islamabad / Rawalpindi, Pakistan.
You get the citizen's claim (category, title, summary) and one or more photos. Judge only what is visible.
- notes: 1-2 short English sentences describing what the photo actually shows that is relevant (e.g. "Uncovered manhole on a street next to a school gate.").
- matches_claim: true if the photo plausibly shows the claimed problem (same kind of issue; the exact street cannot be checked). false if it shows something unrelated, is a screenshot / meme / stock-looking or clearly AI-generated image, is too dark or blurry to tell, or contradicts the claim (e.g. claim says fire, photo shows a normal street).
- severity: how serious the visible situation is, using: critical = immediate danger to life (active fire, live wire on the ground, person trapped / unconscious, collapse); high = serious hazard likely to injure soon (open manhole on a walkway, deep flooding on a road); medium = real problem needing action within a day; low = minor. If the photo does not match, use "low".
- food_type / servings_estimate: ONLY when the claim category is food or the photo clearly shows food on offer: short English food type (e.g. "biryani in large pots"), and an integer number of people it can feed estimated from the visible quantity (one large deg / cooking pot ≈ 50 servings, one full serving tray ≈ 10, one plate ≈ 1; count every container you can see). Otherwise both null.`

function sanitizePhoto(raw: unknown, claim: Extraction): PhotoCheck {
  if (!raw || typeof raw !== 'object') throw new Error('photo check is not an object')
  const r = raw as Record<string, unknown>
  if (typeof r.matches_claim !== 'boolean') throw new Error('photo check missing matches_claim')
  const servings = r.servings_estimate === null || r.servings_estimate === undefined ? null : Number(r.servings_estimate)
  const foodType = str(r.food_type)
  const isFood = claim.category === 'food' || Boolean(foodType)
  return {
    matches_claim: r.matches_claim,
    severity: isUrgency(r.severity) ? r.severity : r.matches_claim ? claim.urgency : 'low',
    notes: str(r.notes) || (r.matches_claim ? 'Photo is consistent with the report.' : 'Photo does not clearly show the reported issue.'),
    food_type: isFood && foodType ? foodType : null,
    servings_estimate: isFood && servings !== null && Number.isFinite(servings) ? Math.round(clamp(servings, 0, 100000)) : null,
  }
}

export async function checkPhoto(input: { imageUrls: string[]; claim: Extraction }): Promise<{ data: PhotoCheck; meta: AiMeta }> {
  const urls = (input.imageUrls ?? []).filter((u) => typeof u === 'string' && /^(https?:|data:image\/)/.test(u)).slice(0, 4)
  if (!urls.length) throw new AiError('vision', 'no usable image URLs')
  const c = input.claim
  const detail = c.category === 'food' ? 'auto' : 'low'
  const claimText = [
    `Claim category: ${c.category}`,
    `Claimed urgency: ${c.urgency}`,
    `Claim title: ${c.title_en}`,
    `Claim summary: ${c.summary_en}`,
    c.food ? `Claimed food: ${c.food.food_type}, about ${c.food.servings_estimate} servings` : '',
    `Photos attached: ${urls.length}`,
  ].filter(Boolean).join('\n')
  const content: InputContent[] = [
    { type: 'input_text', text: claimText },
    ...urls.map((u): InputContent => ({ type: 'input_image', image_url: u, detail })),
  ]
  const { value, meta } = await withFallback('vision', MODELS.vision, async (model) => {
    const { data } = await responsesJson(model, PHOTO_INSTRUCTIONS, content, 'photo_check', PHOTO_SCHEMA, {
      timeoutMs: AI_TIMEOUT_MS.vision,
      label: `vision:${model}`,
      maxOutputTokens: 3000,
    })
    return sanitizePhoto(data, c)
  })
  return { data: value, meta }
}

// ======================================================================= embed

export async function embed(text: string): Promise<{ vector: number[]; model: string; meta: AiMeta }> {
  const input = str(text).slice(0, 8000)
  if (!input) throw new AiError('embed', 'empty text')
  const dims = MODELS.embed.dimensions
  const { value, meta } = await withFallback('embed', MODELS.embed, async (model) => {
    const [vector] = await embeddings(model, [input], dims, { timeoutMs: AI_TIMEOUT_MS.embed, label: `embed:${model}` })
    if (!Array.isArray(vector) || vector.length !== dims) throw new Error(`embedding has ${vector?.length ?? 0} dims, expected ${dims}`)
    return vector
  })
  return { vector: value, model: meta.model, meta }
}

// ======================================================================= sameIncident

const SAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same', 'reason'],
  properties: {
    same: { type: 'boolean' },
    reason: { type: 'string', description: 'one short English sentence' },
  },
}

const SAME_INSTRUCTIONS = `You merge duplicate citizen reports for Awaaz (Islamabad / Rawalpindi civic issues).
Two reports were filed in the SAME category, within 300 m and 6 hours of each other. Decide whether they describe the SAME physical incident (so they become one map pin) or DIFFERENT ones.
- SAME: the same kind of problem at the same spot or landmark, even if worded differently, in different languages, or with more / less detail. If one report lacks location detail but the problem is the same, lean SAME (they are already close together).
- DIFFERENT: a different problem type (open manhole vs broken road, water cut vs pipe leak), clearly different landmarks / streets / house numbers, or two separate occurrences (fires in two different buildings).
reason: one short English sentence.`

export async function sameIncident(a: string, b: string): Promise<{ same: boolean; reason: string; meta: AiMeta }> {
  const content: InputContent[] = [{ type: 'input_text', text: `Report A: """${str(a).slice(0, 1500)}"""\nReport B: """${str(b).slice(0, 1500)}"""` }]
  const { value, meta } = await withFallback('reason', MODELS.reason, async (model) => {
    const { data } = await responsesJson<{ same?: unknown; reason?: unknown }>(model, SAME_INSTRUCTIONS, content, 'same_incident', SAME_SCHEMA, {
      timeoutMs: AI_TIMEOUT_MS.verify,
      label: `same:${model}`,
      maxOutputTokens: 1500,
    })
    if (typeof data?.same !== 'boolean') throw new Error('same_incident missing boolean')
    return { same: data.same, reason: str(data.reason) || (data.same ? 'Same problem at the same place.' : 'Different problems or places.') }
  })
  return { ...value, meta }
}

// ======================================================================= scoreVerification

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'reason_en', 'reason_ur'],
  properties: {
    confidence: { type: 'number', description: 'probability 0..1 that the issue is real and current' },
    reason_en: { type: 'string', description: 'one line, at most 20 words' },
    reason_ur: { type: 'string', description: 'one line in Urdu script, at most 20 words' },
  },
}

const VERIFY_INSTRUCTIONS = `You verify crowd reports for Awaaz (Islamabad / Rawalpindi civic issues). You get one cluster of reports that were merged as the same incident, plus citizen votes and a rule-based heuristic score.
Estimate "confidence": the probability (0 to 1) that this is a REAL, CURRENT issue at roughly the reported place.

Evidence, strongest first:
1. Independent reporters: different people whose descriptions agree. Agreement between people is the strongest signal.
2. Consistency: same problem type and same place details across reports. Contradictions lower confidence.
3. Recency: reports from the last 1-2 hours count fully; older than 6 hours count less (it may already be fixed).
4. Distance: reports within 100 m of the cluster centre are strong; 100-300 m moderate.
5. Photos: a photo that matches the claim adds confidence; a photo that contradicts it lowers it.
6. Votes: confirmations from other citizens raise confidence; disputes lower it.
7. Reporter trust (0..1, 0.5 = new user): trusted reporters raise it a little, low-trust reporters lower it a little.
8. Input modes: independent reports through different modes (voice + text, or with a photo) are more convincing than copy-paste texts.

Hard rules (follow them exactly):
- 2 or more independent, consistent reporters within 300 m and 6 hours => confidence at least 0.75.
- A single report with no confirmations => between 0.3 and 0.5 (up to 0.6 only with a matching photo AND reporter trust above 0.7).
- Disputes outweighing confirmations plus extra reporters => below 0.4. This rule overrides the others.
- The heuristic is a rule-based estimate; stay close to it unless the evidence clearly says otherwise.

reason_en: one line (at most 20 words) naming the main evidence, e.g. "2 independent reports (voice + text) within 50 m in 20 minutes."
reason_ur: the same line in simple Urdu script.`

export async function scoreVerification(
  input: VerificationInput,
): Promise<{ confidence: number; reason_en: string; reason_ur: string; meta: AiMeta }> {
  const payload = {
    category: input.category,
    urgency: input.urgency,
    independent_reporters: input.independent_reporters,
    confirms: input.confirms,
    disputes: input.disputes,
    heuristic: Math.round(input.heuristic * 100) / 100,
    reports: (input.reports ?? []).slice(0, 12).map((r) => ({
      summary_en: str(r.summary_en).slice(0, 300),
      minutes_ago: Math.round(r.minutes_ago),
      distance_m: Math.round(r.distance_m),
      reporter_trust: Math.round(r.reporter_trust * 100) / 100,
      has_photo: r.has_photo,
      photo_matches: r.photo_matches,
      modes: r.modes,
    })),
  }
  const content: InputContent[] = [{ type: 'input_text', text: `Cluster evidence (JSON):\n${JSON.stringify(payload)}` }]
  const { value, meta } = await withFallback('reason', MODELS.reason, async (model) => {
    const { data } = await responsesJson<{ confidence?: unknown; reason_en?: unknown; reason_ur?: unknown }>(
      model, VERIFY_INSTRUCTIONS, content, 'verification_score', VERIFY_SCHEMA,
      { timeoutMs: AI_TIMEOUT_MS.verify, label: `verify:${model}`, maxOutputTokens: 2000 },
    )
    let c = Number(data?.confidence)
    if (!Number.isFinite(c)) throw new Error('verification confidence is not a number')
    if (c > 1 && c <= 100) c = c / 100 // tolerate percentages
    const reason_en = capWords(str(data?.reason_en), 25)
    const reason_ur = capWords(str(data?.reason_ur), 25)
    if (!reason_en) throw new Error('verification reason missing')
    return { confidence: Math.round(clamp(c, 0, 1) * 100) / 100, reason_en, reason_ur: reason_ur || reason_en }
  })
  return { ...value, meta }
}

// ======================================================================= speak

const TTS_INSTRUCTIONS = {
  ur: 'Speak clearly in natural Pakistani Urdu, at a calm and steady pace, like a helpful local radio announcer. Pronounce Islamabad and Rawalpindi place names (sectors such as G-9 or F-7) and numbers the way people in Pakistan say them. Warm and reassuring; serious but not alarming.',
  en: 'Speak clearly in simple English with a friendly, neutral South Asian accent, at a calm and steady pace. Pronounce Islamabad and Rawalpindi place names (sectors such as G-9 or F-7) naturally. Warm and reassuring; serious but not alarming.',
} as const

export async function speak(text: string, lang: 'ur' | 'en'): Promise<{ audio: Uint8Array; mime: 'audio/mpeg'; model: string; voice: string }> {
  const input = str(text).slice(0, 4096)
  if (!input) throw new AiError('tts', 'empty text')
  const { value, meta } = await withFallback('tts', MODELS.tts, async (model, isFallback) => {
    const voice = isFallback ? 'alloy' : MODELS.tts.voice
    const audio = await speech(
      model,
      input,
      { voice, format: 'mp3', ...(isFallback ? {} : { instructions: TTS_INSTRUCTIONS[lang === 'en' ? 'en' : 'ur'] }) },
      { timeoutMs: AI_TIMEOUT_MS.tts, label: `tts:${model}` },
    )
    return { audio, voice }
  })
  return { audio: value.audio, mime: 'audio/mpeg', model: meta.model, voice: value.voice }
}

/** Voice used by a given TTS model (keeps the tts cache key in sync with speak()). */
export function ttsVoiceFor(model: string): string {
  return model === MODELS.tts.primary ? MODELS.tts.voice : 'alloy'
}

// ======================================================================= digest

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['en', 'ur'],
  properties: {
    en: { type: 'string', description: 'English briefing, at most 70 words' },
    ur: { type: 'string', description: 'Urdu-script briefing, at most 70 words' },
  },
}

const DIGEST_INSTRUCTIONS = `You write very short briefings for Awaaz, a civic-issue map of Islamabad / Rawalpindi. They are shown on a phone AND read aloud to people who may not read, so use plain, spoken, simple words.
Return JSON {en, ur}: the same briefing in English and in natural Pakistani Urdu (Urdu script; not a word-by-word translation). Each at most 70 words. Use digits for numbers. No markdown, no bullets, no emojis, no lists of IDs.
Content, in this order:
1. One line with the total and the counts by category (only categories that appear).
2. The most urgent items first (critical, then high): what and where, and whether it is verified, unconfirmed or already being handled. Mention at most 3 items.
3. End with ONE practical safety tip that fits the most urgent issue (e.g. keep children away from open manholes; never touch fallen wires; do not drive through flooded roads; boil drinking water; call 1122 in an emergency).
Mode "nearby": speak to a citizen about what is happening near them; include how far the top items are (e.g. "400 m away").
Mode "daily": a summary of the last 24 hours for a responder team (use the team name if given) or for the city; statuses here are the team's assignment status (alerted = waiting for someone to claim it). Point out what still needs action.
Only use the items given. Never invent incidents, places, numbers or statuses.`

const URGENCY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`
}

function fmtAgo(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} min ago`
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} days ago`
}

export async function digest(input: { pins: DigestPin[]; mode: 'nearby' | 'daily'; orgName?: string }): Promise<{ en: string; ur: string; meta: AiMeta }> {
  const pins = [...(input.pins ?? [])].sort(
    (a, b) => (URGENCY_RANK[b.urgency] ?? 0) - (URGENCY_RANK[a.urgency] ?? 0) || a.minutes_ago - b.minutes_ago,
  )
  const counts: Record<string, number> = {}
  for (const p of pins) counts[p.category] = (counts[p.category] ?? 0) + 1
  const lines = pins.slice(0, 25).map((p) => {
    const parts = [
      `[${p.urgency}] ${p.category}`,
      `"${str(p.title_en).slice(0, 120)}"`,
      `status ${p.status}`,
      `${p.report_count} report${p.report_count === 1 ? '' : 's'}`,
      fmtAgo(p.minutes_ago),
    ]
    if (typeof p.distance_m === 'number') parts.push(`${fmtDistance(p.distance_m)} away`)
    return `- ${parts.join(', ')}`
  })
  const header = [
    `Mode: ${input.mode}`,
    input.orgName ? `Team: ${str(input.orgName).slice(0, 100)}` : '',
    `Total items: ${pins.length}`,
    `Counts by category: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    'Items (most urgent first):',
  ].filter(Boolean)
  const content: InputContent[] = [{ type: 'input_text', text: [...header, ...lines].join('\n') }]
  const { value, meta } = await withFallback('digest', MODELS.digest, async (model) => {
    const { data } = await responsesJson<{ en?: unknown; ur?: unknown }>(model, DIGEST_INSTRUCTIONS, content, 'area_digest', DIGEST_SCHEMA, {
      timeoutMs: AI_TIMEOUT_MS.digest,
      label: `digest:${model}`,
      maxOutputTokens: 2500,
    })
    const en = capWords(str(data?.en), 80, true)
    const ur = capWords(str(data?.ur), 80, true)
    if (!en || !ur) throw new Error('digest missing en or ur')
    return { en, ur }
  })
  return { ...value, meta }
}
