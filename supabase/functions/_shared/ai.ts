// The ONLY module other Edge Function code uses for AI (docs/CONTRACT.md §2).
// Every task runs on OpenAI: MODELS.<task>.primary, then MODELS.<task>.fallback on failure / timeout / invalid output.
// Prompts are tuned for Islamabad / Rawalpindi: Urdu script, Roman Urdu, Punjabi, English and code-switching.

import { MODELS, OPENAI_BASE } from './models.ts'
import { AI_TIMEOUT_MS, FOOD_DEFAULT_SAFE_HOURS } from './config.ts'
import { embeddings, OpenAIError, outputText, responsesJson, speech, transcription, type InputContent, type Usage } from './openai.ts'
import {
  ATTRIBUTE_ICON_NAMES,
  type AttributeMap,
  CATEGORY_ATTRIBUTE_HINTS,
  DEFAULT_ATTRIBUTES,
  MAX_INTAKE_QUESTIONS,
  type ReportAttribute,
  sanitizeAttributes,
  type UserUrgency,
} from './attributes.ts'
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

// ======================================================================= no-speech detection (Phase 1b)
// Deterministic guard used BEFORE any AI call: silence, noise markers, filler sounds and the well-known
// speech-to-text hallucinations on silent clips ("thank you for watching", "subscribe", a lone "شکریہ").

export type NoSpeechReason = 'empty' | 'hallucination' | 'too_short'
export interface NoSpeechCheck {
  no_speech: boolean
  reason: NoSpeechReason | null
  /** number of real content words that remain after removing markers / fillers / hallucinations */
  words: number
}

/** [music], (noise), *applause*, <silence>, ♪ … */
const SPEECH_MARKERS = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|<[^>]*>|[♪♫♬]+/g
const URDU_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g

function normSpeech(s: string): string {
  return s
    .normalize('NFC')
    .replace(URDU_DIACRITICS, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[هة]/g, 'ہ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Phrases removed anywhere in a transcript (normalised form). */
const HALLUCINATION_PHRASES = [
  'thank you so much for watching', 'thank you very much for watching', 'thank you for watching', 'thanks for watching',
  'thank you for listening', 'thanks for listening', 'please like and subscribe', 'like and subscribe',
  'don t forget to subscribe', 'please subscribe', 'subscribe to my channel', 'subscribe to the channel',
  'subscribe to our channel', 'subscribe', 'subtitles by the amara org community', 'subtitles by', 'subtitled by',
  'captions by', 'transcribed by', 'amara org', 'see you in the next video', 'see you next time',
  'blank audio', 'no speech', 'inaudible', 'music', 'applause', 'laughter', 'silence', 'background noise',
  'دیکھنے کا شکریہ', 'دیکھنے کے لیے شکریہ', 'سننے کا شکریہ', 'ہمارے چینل کو سبسکرائب کریں', 'چینل کو سبسکرائب کریں',
  'لائک اور سبسکرائب', 'سبسکرائب کریں', 'سبسکرائب', 'dekhne ka shukriya', 'subscribe karein', 'subscribe karen',
  'देखने के लिए धन्यवाद', 'सब्सक्राइब', 'धन्यवाद',
].map(normSpeech).sort((a, b) => b.length - a.length)

/** Whole-transcript hallucinations / content-free phrases. */
const WHOLE_HALLUCINATIONS = new Set([
  'you', 'thank you', 'thank you very much', 'thank you so much', 'thanks', 'thanks a lot', 'bye', 'bye bye', 'the end',
  'شکریہ', 'بہت شکریہ', 'شکریہ ادا', 'جزاک اللہ', 'اللہ حافظ', 'خدا حافظ', 'shukriya', 'shukria', 'bohat shukriya',
  'bahut shukriya', 'jazakallah', 'allah hafiz', 'khuda hafiz', 'शुक्रिया', 'धन्यवाद',
].map(normSpeech))

/** Greetings: real speech, but no report content on their own. */
const GREETING_PHRASES = [
  'assalam o alaikum', 'assalamu alaikum', 'assalam alaikum', 'asalam o alaikum', 'aslam o alaikum', 'salam alaikum',
  'السلام علیکم', 'اسلام علیکم', 'salaam', 'salam', 'سلام', 'hello', 'hellow', 'ہیلو', 'hi', 'hey',
].map(normSpeech).sort((a, b) => b.length - a.length)

const FILLER_TOKENS = new Set(['uh', 'um', 'umm', 'uhm', 'hmm', 'hmmm', 'hm', 'mm', 'mmm', 'ah', 'aah', 'ahh', 'oh', 'ohh', 'huh', 'er', 'erm', 'eh', 'آں', 'ہمم', 'اوہ', 'آہ'])

function removePhrases(padded: string, phrases: string[]): { text: string; hit: boolean } {
  let s = padded
  let hit = false
  for (const p of phrases) {
    const needle = ` ${p} `
    while (s.includes(needle)) {
      s = s.replace(needle, ' ')
      hit = true
    }
  }
  return { text: s, hit }
}

/** The tokens are one whole-transcript hallucination repeated ("شکریہ شکریہ", "thank you thank you"). */
function isRepeatedHallucination(tokens: string[]): boolean {
  for (const p of WHOLE_HALLUCINATIONS) {
    const pt = p.split(' ')
    if (tokens.length % pt.length !== 0) continue
    let all = true
    for (let i = 0; i < tokens.length && all; i++) all = tokens[i] === pt[i % pt.length]
    if (all) return true
  }
  return false
}

/**
 * Is this transcript / text effectively silence? `minWords` = real content words required (default 2 — a first
 * description; use 1 for answers to a follow-up question such as "haan" / "teen" / "no", and for a name).
 */
export function detectNoSpeech(text: string | null | undefined, opts: { minWords?: number } = {}): NoSpeechCheck {
  const minWords = Math.max(1, opts.minWords ?? 2)
  const norm = normSpeech(String(text ?? '').replace(SPEECH_MARKERS, ' '))
  if (!norm) return { no_speech: true, reason: 'empty', words: 0 }
  if (WHOLE_HALLUCINATIONS.has(norm)) return { no_speech: true, reason: 'hallucination', words: 0 }
  const h = removePhrases(` ${norm} `, HALLUCINATION_PHRASES)
  const g = removePhrases(h.text, GREETING_PHRASES)
  const real = g.text.trim().split(' ').filter((t) => t && !FILLER_TOKENS.has(t) && (/\p{N}/u.test(t) || [...t].length >= 2))
  const leftover = real.join(' ')
  if (leftover && WHOLE_HALLUCINATIONS.has(leftover)) return { no_speech: true, reason: 'hallucination', words: 0 }
  if (real.length > 1 && isRepeatedHallucination(real)) return { no_speech: true, reason: 'hallucination', words: 0 } // "Thank you. Thank you."

  if (!real.length) return { no_speech: true, reason: g.hit ? 'too_short' : h.hit ? 'hallucination' : 'empty', words: 0 }
  if (real.length < minWords) return { no_speech: true, reason: h.hit ? 'hallucination' : 'too_short', words: real.length }
  return { no_speech: false, reason: null, words: real.length }
}

// ======================================================================= intakeTurn (Phase 1b report-chat)

/** Same shapes as src/lib/attributes.ts (QuickReply, IntakeDraft). */
export interface QuickReply { key: string; value: string; label_en: string; label_ur: string; icon: string }
export interface IntakeDraft {
  category: Category
  urgency: Urgency
  title_en: string
  title_ur: string
  summary_en: string
  summary_ur: string
}

export interface IntakeTurnInput {
  uiLanguage: 'ur' | 'en'
  /** conversation before this turn (oldest first) */
  history: { role: 'user' | 'ai'; text: string }[]
  /** attributes known so far, WITH this turn's tapped quick reply already applied (see applyQuickReply) */
  attributes: AttributeMap
  /** what the user did this turn */
  turnKind: 'voice' | 'text' | 'quick_reply' | 'photo'
  /** this turn's words (transcript or typed text); '' for a tap / photo-only turn */
  turnText: string
  quickReply?: { key: string; value: string } | null
  /** AI questions already asked before this turn */
  questionsAsked: number
  /** the first question must offer the user-urgency chips */
  askUrgency: boolean
  hasImage: boolean
  hasGps: boolean
}

export interface IntakeTurnResult {
  reply_en: string
  reply_ur: string
  quick_replies: QuickReply[]
  /** FULL updated attribute map (known attributes merged with this turn's updates; user-given values protected) */
  attributes: AttributeMap
  draft: IntakeDraft
  ready: boolean
  emergency: boolean
  ask_photo: boolean
  /** nothing in the whole conversation is a local problem (greeting / chit-chat / joke / test) */
  off_topic: boolean
}

/**
 * Reasoning effort for the intake + profile calls: "none" measured fastest and reliable (the phase-aware parser in
 * openai.ts skips the occasional extra "commentary" message). Env AI_INTAKE_EFFORT=low switches back without a deploy of code.
 */
const INTAKE_EFFORT: 'none' | 'low' = Deno.env.get('AI_INTAKE_EFFORT') === 'low' ? 'low' : 'none'
const INTAKE_TIMEOUT_MS = 12000
const PROFILE_TIMEOUT_MS = 10000

const ICONS = ATTRIBUTE_ICON_NAMES as readonly string[]
const DEFAULT_ATTR_MAP = new Map<string, { key: string; icon: string; label_en: string; label_ur: string }>(
  DEFAULT_ATTRIBUTES.map((a) => [a.key, a]),
)

export const USER_URGENCY_LABELS: Record<UserUrgency, { en: string; ur: string; icon: string; severity: ReportAttribute['severity'] }> = {
  emergency: { en: 'Emergency', ur: 'ایمرجنسی', icon: 'siren', severity: 'danger' },
  urgent: { en: 'Urgent', ur: 'فوری', icon: 'alert-triangle', severity: 'warn' },
  can_wait: { en: 'Can wait', ur: 'انتظار ہو سکتا ہے', icon: 'clock', severity: 'info' },
}

/** The three user-urgency chips offered on the first question. */
export const URGENCY_QUICK_REPLIES: QuickReply[] = (['emergency', 'urgent', 'can_wait'] as const).map((u) => ({
  key: 'user_urgency',
  value: u,
  label_en: USER_URGENCY_LABELS[u].en,
  label_ur: USER_URGENCY_LABELS[u].ur,
  icon: USER_URGENCY_LABELS[u].icon,
}))

/** 'emergency' | 'urgent' | 'can_wait' from a machine value or a label (EN / UR / Roman Urdu). */
export function parseUserUrgency(v: unknown): UserUrgency | null {
  const s = str(v).toLowerCase()
  if (!s) return null
  if (/emerg|ایمرجنسی|ہنگامی/.test(s)) return 'emergency'
  if (/can.?wait|wait|later|not urgent|انتظار|بعد میں/.test(s)) return 'can_wait'
  if (/urgent|jaldi|fori|فوری|جلدی|ضروری/.test(s)) return 'urgent'
  return null
}

/** The user_urgency attribute in canonical form (value_en exactly 'Emergency' | 'Urgent' | 'Can wait'). */
export function userUrgencyAttribute(u: UserUrgency, source: ReportAttribute['source'] = 'user'): ReportAttribute {
  const m = USER_URGENCY_LABELS[u]
  return {
    key: 'user_urgency', label_en: 'How urgent', label_ur: 'کتنا ضروری', value_en: m.en, value_ur: m.ur,
    icon: 'siren', severity: m.severity, source,
  }
}

/** UserUrgency recorded in an attribute map, if any. */
export function userUrgencyOf(attrs: AttributeMap | null | undefined): UserUrgency | null {
  const a = attrs?.user_urgency
  return a ? parseUserUrgency(a.value_en) : null
}

function humanize(key: string): string {
  const s = key.replace(/_/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : key
}

function snakeKey(v: unknown): string {
  return str(v).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

/** Machine value of a chip: lowercase, spaces -> _, keeps digits / letters (any script) / . - _ */
function chipValue(v: unknown): string {
  return str(v).toLowerCase().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_.\-]/gu, '').slice(0, 40)
}

const YES_NO_VALUES: Record<string, { en: string; ur: string }> = {
  yes: { en: 'Yes', ur: 'ہاں' },
  no: { en: 'No', ur: 'نہیں' },
  unknown: { en: 'Not sure', ur: 'معلوم نہیں' },
  not_sure: { en: 'Not sure', ur: 'معلوم نہیں' },
  dont_know: { en: 'Not sure', ur: 'معلوم نہیں' },
}

/** Keys whose "yes" means risk to life / limb, and keys whose "no" does. */
const DANGER_IF_YES = new Set([
  'injuries', 'children_at_risk', 'people_trapped', 'stranded_people', 'weapon_seen', 'ongoing_threat', 'bleeding',
  'gas_cylinder_nearby', 'water_rising', 'wire_live', 'sparking', 'anyone_inside', 'people_inside', 'anyone_hurt',
  'anyone_trapped', 'unconscious',
])
const DANGER_IF_NO = new Set(['conscious', 'breathing'])
const WARN_IF_YES = new Set(['still_happening', 'road_blocked', 'houses_flooded', 'recurring'])

/**
 * Deterministically apply a tapped quick reply to the attribute map (BEFORE the AI call), source 'user'.
 * label_en / label_ur / icon = the chip's own labels when the client sends them back (optional).
 */
export function applyQuickReply(
  attrs: AttributeMap,
  qr: { key: string; value: string; label_en?: string; label_ur?: string; icon?: string },
): AttributeMap {
  const key = snakeKey(qr.key)
  const value = chipValue(qr.value)
  if (!key || !value) return attrs
  if (key === 'user_urgency') {
    const u = parseUserUrgency(value)
    return u ? { ...attrs, user_urgency: userUrgencyAttribute(u, 'user') } : attrs
  }
  const prev = attrs[key]
  const def = DEFAULT_ATTR_MAP.get(key)
  const yn = YES_NO_VALUES[value]
  const value_en = yn?.en ?? (str(qr.label_en) || humanize(value))
  const value_ur = yn?.ur ?? (str(qr.label_ur) || str(qr.label_en) || humanize(value))
  let severity: ReportAttribute['severity'] = prev?.severity ?? 'info'
  if (value === 'yes' && DANGER_IF_YES.has(key)) severity = 'danger'
  else if (value === 'no' && DANGER_IF_NO.has(key)) severity = 'danger'
  else if (value === 'yes' && WARN_IF_YES.has(key)) severity = 'warn'
  else if (yn) severity = 'info'
  const icon = def?.icon ?? prev?.icon ?? (ICONS.includes(str(qr.icon)) ? str(qr.icon) : 'info')
  return {
    ...attrs,
    [key]: {
      key,
      label_en: def?.label_en ?? prev?.label_en ?? humanize(key),
      label_ur: def?.label_ur ?? prev?.label_ur ?? humanize(key),
      value_en: value_en.slice(0, 120),
      value_ur: value_ur.slice(0, 120),
      icon,
      severity,
      source: 'user',
    },
  }
}

/** A tapped value the server labels exactly (the AI must not rephrase it). */
function isDeterministicValue(value: string): boolean {
  const v = chipValue(value)
  return v in YES_NO_VALUES || /^\d+(\.\d+)?$/.test(v)
}

const INTAKE_ATTRIBUTE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value_en', 'value_ur', 'label_en', 'label_ur', 'icon', 'severity', 'source'],
  properties: {
    key: { type: 'string', description: 'snake_case' },
    value_en: { type: 'string', description: '1-4 words' },
    value_ur: { type: 'string', description: '1-4 words, Urdu script' },
    label_en: { type: 'string', description: '"" for default keys' },
    label_ur: { type: 'string', description: '"" for default keys' },
    icon: { type: 'string', enum: [...ATTRIBUTE_ICON_NAMES, ''] },
    severity: { type: 'string', enum: ['info', 'warn', 'danger'] },
    source: { type: 'string', enum: ['user', 'ai'] },
  },
}

// Property order = generation order: the decision and the spoken reply come FIRST so the reply can be streamed
// to text-to-speech while the model is still writing the draft and attributes.
const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['emergency', 'ready', 'off_topic', 'reply_en', 'reply_ur', 'quick_replies', 'ask_photo', 'draft', 'attributes'],
  properties: {
    emergency: { type: 'boolean' },
    ready: { type: 'boolean' },
    off_topic: { type: 'boolean' },
    reply_en: { type: 'string' },
    reply_ur: { type: 'string', description: 'Urdu script' },
    quick_replies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'label_en', 'label_ur', 'icon'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string', description: 'machine-readable: yes / no / a number / snake_case option' },
          label_en: { type: 'string' },
          label_ur: { type: 'string' },
          icon: { type: 'string', enum: [...ATTRIBUTE_ICON_NAMES] },
        },
      },
    },
    ask_photo: { type: 'boolean' },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'urgency', 'title_en', 'title_ur', 'summary_en', 'summary_ur'],
      properties: {
        category: { type: 'string', enum: CATEGORIES },
        urgency: { type: 'string', enum: URGENCIES },
        title_en: { type: 'string', description: 'at most 8 words' },
        title_ur: { type: 'string', description: 'at most 8 words, Urdu script' },
        summary_en: { type: 'string', description: '1-2 short sentences' },
        summary_ur: { type: 'string', description: '1-2 short sentences, Urdu script' },
      },
    },
    attributes: { type: 'array', items: INTAKE_ATTRIBUTE_ITEM, description: 'facts that are new or changed this turn' },
  },
}

const INTAKE_INSTRUCTIONS = `You run the intake conversation for Awaaz, a voice-first app where citizens of Islamabad / Rawalpindi, Pakistan report local problems to responders (Rescue 1122, fire brigade, police, WASA / CDA / IESCO, NGOs, food banks). Many users cannot read: your reply is spoken aloud, and they answer by speaking or by tapping big icon buttons (quick replies).
Each call is ONE turn. You get the context, the facts (attributes) known so far, the conversation so far and this turn's input (a voice transcript that may be noisy, typed text, a tapped button, or a new photo). Return ONE JSON object matching the schema.
Goal: the most useful facts for responders in the fewest questions — at most ${MAX_INTAKE_QUESTIONS} questions in the whole conversation.
Users speak Urdu script, Roman Urdu, Punjabi / Pothwari, English or a mix (gutter khula = open manhole, bijli ki taar = electric wire, aag = fire, dhuan = smoke, pani = water, nala = storm drain, zakhmi = injured, behosh = unconscious, bachay = children, sarak = road, gali = street, jaldi = quickly).

ATTRIBUTES — list every fact that is NEW or CHANGED by this turn (facts already known with the same value: leave them out).
- Default keys: ${DEFAULT_ATTRIBUTES.map((a) => `${a.key} (${a.label_en})`).join(', ')}.
- Category keys (use when relevant):
${Object.entries(CATEGORY_ATTRIBUTE_HINTS).filter(([, v]) => v.length).map(([k, v]) => `  ${k}: ${v.join('; ')}`).join('\n')}
- You may add other short snake_case keys that matter to responders.
- value_en / value_ur: 1-4 words ("3 people" / "3 لوگ", "Yes" / "ہاں", "No" / "نہیں", "Since morning" / "صبح سے", "Knee deep" / "گھٹنوں تک"); value_ur in Urdu script.
- label_en / label_ur / icon: "" for default keys (filled in automatically); for any other key give a 1-3 word label in both languages and the best icon.
- severity: "danger" = risk to life or limb (someone hurt or trapped, children at risk, live wire, fire spreading, unconscious, weapon); "warn" = serious (road blocked, still happening, water rising); "info" = neutral facts.
- source: "user" when the user said or tapped it explicitly; "ai" when you inferred it.
- Fill everything that can be inferred from what was already said (e.g. "school ke bahar gutter khula" -> landmark "School", hazard_type "Open manhole", children_at_risk "Yes" (ai)). Never invent facts; never write "unknown".
- user_urgency: ONLY when the user themselves said how urgent it is; value_en exactly "Emergency", "Urgent" or "Can wait".

DRAFT — the report as it stands now: category (hazard = open manhole, live / fallen wire, broken road, collapsed wall, fallen tree; fire; flood = waterlogging, nala overflow; water = supply cut, dirty water, pipe leak; food = surplus food to donate or hunger; health = injured / sick / unconscious person, dengue; safety = crime, harassment, violence, threats; other), urgency (critical = danger to life right now; high = likely to hurt someone soon or affects many; medium = needs action within a day; low = inconvenience), title_en / title_ur (at most 8 words: problem + place), summary_en / summary_ur (1-2 short sentences with the key facts). Urdu fields in Urdu script.

FLAGS
- emergency = true only when the words clearly show danger to life RIGHT NOW (fire with people inside or nearby, an unconscious or not-breathing person, a live / sparking electric wire on a road or in water, someone drowning or trapped, violence in progress) OR the user says it is an emergency. A fallen wire, open manhole or flooding with no sign yet of immediate harm is NOT an emergency (draft urgency high): ask instead.
- ready = true when responders can act: what the problem is + where (GPS point or a landmark / street) + the key danger fact for the category is known (hazard: anyone hurt / wire live or sparking; fire: anyone inside or trapped; flood: anyone stranded / water rising; water: how many homes / since when; health: conscious and breathing; safety: is the danger still there; food: how many people it can feed). Also true when emergency is true or no questions are left.
- ask_photo = true when a photo would clearly help (visible hazard, damage, flooding, fire, food on offer) and none is attached yet. Never for emergencies or crime / violence.
- off_topic = true ONLY when the whole conversation contains no local problem at all (only greetings, chit-chat, a song, a joke, abuse, a test). When in doubt: false.

REPLY — reply_en and reply_ur say the same thing; reply_ur is natural spoken Pakistani Urdu in Urdu script (never Roman Urdu).
- Not ready: ONE short question (at most 15 words, very simple words), optionally after a 1-2 word acknowledgement ("OK." / "جی۔"). Ask the single most important unknown for THIS category: danger to people first (anyone hurt or trapped, children), then where exactly (only when there is no GPS point and no landmark or street), then size / how many people, then since when. Never ask anything already known. Prefer yes / no or 2-4 choices.
- Ready: a short confirmation of what will be sent (at most 30 words), ending with "Sending now?" / "ابھی بھیج دیں؟". If emergency: end with "Sending help now." / "ابھی مدد کے لیے بھیج رہے ہیں۔"
- off_topic: kindly ask what problem there is in their area.

QUICK_REPLIES — tap-able answers to your question (0-4; [] when ready or off_topic).
- key = the attribute key the answer fills. For a yes / no question use a key named after the question (wire_live, anyone_inside, injuries, water_rising) — NEVER a key that already holds a different fact (e.g. not hazard_type for "is it sparking?").
- value = machine-readable: "yes", "no", a number ("3"), or a short snake_case option ("knee_deep"); label_en / label_ur 1-3 words; icon that fits the meaning.
- When the context says "Ask urgency now": unless emergency is true, ready = false, the question is how urgent it is and the quick replies are exactly user_urgency emergency (siren) / urgent (alert-triangle) / can_wait (clock).

EXAMPLE
Context: Ask urgency now; GPS point: yes; photo attached: no. This turn (voice): """gali number 5 mein school ke bahar gutter khula hai"""
Output: {"emergency":false,"ready":false,"off_topic":false,"reply_en":"OK. How urgent is it?","reply_ur":"جی۔ یہ کتنا ضروری ہے؟","quick_replies":[{"key":"user_urgency","value":"emergency","label_en":"Emergency","label_ur":"ایمرجنسی","icon":"siren"},{"key":"user_urgency","value":"urgent","label_en":"Urgent","label_ur":"فوری","icon":"alert-triangle"},{"key":"user_urgency","value":"can_wait","label_en":"Can wait","label_ur":"انتظار ہو سکتا ہے","icon":"clock"}],"ask_photo":true,"draft":{"category":"hazard","urgency":"high","title_en":"Open manhole outside Street 5 school","title_ur":"گلی 5 کے اسکول کے باہر کھلا گٹر","summary_en":"An open manhole outside the school on Street 5. Children could fall in.","summary_ur":"گلی نمبر 5 میں اسکول کے باہر گٹر کھلا ہے۔ بچے گر سکتے ہیں۔"},"attributes":[{"key":"landmark","value_en":"School, Street 5","value_ur":"اسکول، گلی 5","label_en":"","label_ur":"","icon":"","severity":"info","source":"user"},{"key":"hazard_type","value_en":"Open manhole","value_ur":"کھلا گٹر","label_en":"Hazard","label_ur":"خطرہ","icon":"alert-triangle","severity":"danger","source":"user"},{"key":"children_at_risk","value_en":"Yes","value_ur":"ہاں","label_en":"","label_ur":"","icon":"","severity":"danger","source":"ai"}]}
Next turn — Context: 1 question asked (2 left). This turn — the user tapped: user_urgency = urgent
Output: {"emergency":false,"ready":false,"off_topic":false,"reply_en":"Has anyone fallen in or been hurt?","reply_ur":"کیا کوئی اس میں گرا ہے یا زخمی ہوا ہے؟","quick_replies":[{"key":"injuries","value":"yes","label_en":"Yes","label_ur":"ہاں","icon":"bandage"},{"key":"injuries","value":"no","label_en":"No","label_ur":"نہیں","icon":"bandage"}],"ask_photo":true,"draft":{ ...the same draft... },"attributes":[]}`

function buildIntakeInput(input: IntakeTurnInput): string {
  const left = Math.max(0, MAX_INTAKE_QUESTIONS - input.questionsAsked)
  const lines: string[] = [
    `App language: ${input.uiLanguage === 'ur' ? 'Urdu (the user hears reply_ur)' : 'English (the user hears reply_en)'}`,
    `Questions asked so far: ${input.questionsAsked} of ${MAX_INTAKE_QUESTIONS} (${left} left)`,
  ]
  if (left === 0) lines.push('No questions left: set ready = true and give the final confirmation.')
  else if (input.askUrgency) lines.push('Ask urgency now: unless emergency is true, ready = false and ask how urgent it is with the 3 urgency quick replies.')
  lines.push(`GPS point: ${input.hasGps ? 'yes' : 'no'}`, `Photo attached: ${input.hasImage ? 'yes' : 'no'}`)

  const known = Object.values(input.attributes ?? {})
  lines.push('Known attributes:')
  if (known.length) {
    for (const a of known.slice(0, 20)) lines.push(`- ${a.key}: ${a.value_en} / ${a.value_ur} [${a.severity}, ${a.source}]`)
  } else lines.push('- none')

  const hist = (input.history ?? []).filter((t) => str(t.text)).slice(-12)
  lines.push('Conversation so far:')
  if (hist.length) for (const t of hist) lines.push(`${t.role === 'ai' ? 'AI' : 'User'}: ${str(t.text).slice(0, 600)}`)
  else lines.push('(none — this is the first turn)')

  const words = str(input.turnText).slice(0, 2000)
  if (input.quickReply) lines.push(`This turn — the user tapped: ${input.quickReply.key} = ${input.quickReply.value}`)
  if (input.turnKind === 'photo' && !words) lines.push('This turn — the user added a photo (no words).')
  if (words) lines.push(`This turn — the user (${input.turnKind === 'voice' ? 'voice transcript, may be noisy' : 'typed'}): """${words}"""`)
  return lines.join('\n')
}

function sanitizeQuickReplies(raw: unknown): QuickReply[] {
  if (!Array.isArray(raw)) return []
  const out: QuickReply[] = []
  const seen = new Set<string>()
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const r = q as Record<string, unknown>
    const key = snakeKey(r.key)
    const value = chipValue(r.value)
    if (!key || !value || seen.has(`${key}=${value}`)) continue
    seen.add(`${key}=${value}`)
    const label_en = capWords(str(r.label_en), 4) || humanize(value)
    const label_ur = capWords(str(r.label_ur), 5) || label_en
    out.push({ key, value, label_en, label_ur, icon: ICONS.includes(str(r.icon)) ? str(r.icon) : 'info' })
    if (out.length >= 4) break
  }
  return out
}

/** Model attribute items -> validated ReportAttributes (labels / icons of default keys filled in). */
function attributeUpdates(raw: unknown): ReportAttribute[] {
  if (!Array.isArray(raw)) return []
  const out: ReportAttribute[] = []
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const key = snakeKey(r.key)
    const value_en = capWords(str(r.value_en), 8)
    if (!key || !value_en || /^(unknown|n\/?a|none|not known)$/i.test(value_en)) continue
    const source: ReportAttribute['source'] = r.source === 'user' ? 'user' : 'ai'
    if (key === 'user_urgency') {
      const u = parseUserUrgency(value_en) ?? parseUserUrgency(r.value_ur)
      if (u) out.push(userUrgencyAttribute(u, source))
      continue
    }
    const def = DEFAULT_ATTR_MAP.get(key)
    const icon = str(r.icon)
    out.push({
      key,
      label_en: def?.label_en ?? (capWords(str(r.label_en), 4) || humanize(key)),
      label_ur: def?.label_ur ?? (capWords(str(r.label_ur), 5) || capWords(str(r.label_en), 4) || humanize(key)),
      value_en,
      value_ur: capWords(str(r.value_ur), 8) || value_en,
      icon: def?.icon ?? (ICONS.includes(icon) ? icon : 'info'),
      severity: r.severity === 'danger' || r.severity === 'warn' ? r.severity : 'info',
      source,
    })
  }
  return out
}

/**
 * Merge this turn's updates into the known attributes:
 * - a value the user gave earlier (source 'user') is only replaced by another user-given value;
 * - the chip tapped THIS turn keeps exactly the value applied by applyQuickReply for user_urgency / yes / no /
 *   numbers; for other chip values the AI may only re-word it (source forced to 'user').
 */
function mergeAttributes(prev: AttributeMap, updates: ReportAttribute[], tapped?: { key: string; value: string } | null): AttributeMap {
  const out: AttributeMap = { ...prev }
  const tappedKey = tapped ? snakeKey(tapped.key) : ''
  const tappedFixed = tapped ? tappedKey === 'user_urgency' || isDeterministicValue(tapped.value) : false
  const sevRank = { info: 0, warn: 1, danger: 2 } as const
  for (const a of updates) {
    const p = prev[a.key]
    if (a.key === tappedKey) {
      if (tappedFixed && p) {
        if (a.key === 'user_urgency') continue // the user's urgency choice is never re-worded
        // keep the tapped value + source exactly; take the AI's wording of the label, icon and severity
        const generic = !DEFAULT_ATTR_MAP.has(a.key)
        out[a.key] = {
          ...p,
          ...(generic ? { label_en: a.label_en, label_ur: a.label_ur, icon: a.icon !== 'info' ? a.icon : p.icon } : {}),
          severity: sevRank[a.severity] > sevRank[p.severity] ? a.severity : p.severity,
        }
        continue
      }
      out[a.key] = { ...a, source: 'user' }
      continue
    }
    if (p?.source === 'user' && a.source !== 'user') continue
    out[a.key] = a
  }
  // defaults first (stable display order), then extras; sanitizeAttributes caps at 20
  const ordered: AttributeMap = {}
  for (const d of DEFAULT_ATTRIBUTES) if (out[d.key]) ordered[d.key] = out[d.key]
  for (const [k, v] of Object.entries(out)) if (!ordered[k]) ordered[k] = v
  return sanitizeAttributes(ordered)
}

const YES_NO_TEXT = /^(yes|no|not sure|ہاں|نہیں|معلوم نہیں)$/i
const QUESTION_STOPWORDS = new Set([
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'did', 'does', 'do', 'can', 'could', 'will', 'would', 'should',
  'the', 'a', 'an', 'any', 'there', 'it', 'its', 'this', 'that', 'these', 'of', 'or', 'and', 'in', 'on', 'at', 'to',
  'been', 'be', 'still', 'ok', 'okay', 'noted', 'yes', 'no', 'please', 'tell', 'me', 'us', 'you', 'your',
])

/** snake_case key from the question, e.g. "Is the fallen wire live or sparking?" -> "fallen_wire_live". */
function keyFromQuestion(q: string): string {
  const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !QUESTION_STOPWORDS.has(w))
  return snakeKey(words.slice(0, 3).join('_'))
}

/**
 * Guard: yes / no chips must not overwrite a different fact (e.g. key hazard_type = "Fallen electric wire" for
 * "Is it sparking?"). Such chips get a key derived from the question instead.
 */
function rekeyYesNoChips(chips: QuickReply[], known: AttributeMap, updates: ReportAttribute[], question: string): QuickReply[] {
  const updated = new Map(updates.map((a) => [a.key, a]))
  const rename = new Map<string, string>()
  for (const c of chips) {
    if (rename.has(c.key) || c.key === 'user_urgency' || !(c.value in YES_NO_VALUES)) continue
    const a = updated.get(c.key) ?? known[c.key]
    if (!a || YES_NO_TEXT.test(a.value_en.trim())) continue
    const k = keyFromQuestion(question)
    if (k && k !== c.key && !known[k]) rename.set(c.key, k)
  }
  return rename.size ? chips.map((c) => (c.value in YES_NO_VALUES && rename.has(c.key) ? { ...c, key: rename.get(c.key)! } : c)) : chips
}

/** Shared by the streamed early reply and the final parse so both produce the identical spoken text. */
function cleanReplyPair(rawEn: unknown, rawUr: unknown, strict: boolean): { en: string; ur: string } {
  const en0 = capWords(str(rawEn), 45)
  let ur = capWords(str(rawUr), 50)
  if (!en0 && !ur) throw new Error('intake reply missing')
  if (ur && !hasUrdu(ur)) {
    if (strict) throw new Error('intake reply_ur is not in Urdu script')
    ur = ''
  }
  const en = en0 || ur
  return { en, ur: ur || en }
}

function sanitizeIntake(raw: unknown, input: IntakeTurnInput, strict: boolean): IntakeTurnResult {
  if (!raw || typeof raw !== 'object') throw new Error('intake output is not an object')
  const r = raw as Record<string, unknown>
  const { en: reply_en, ur: reply_ur } = cleanReplyPair(r.reply_en, r.reply_ur, strict)

  const d = (r.draft && typeof r.draft === 'object' ? r.draft : {}) as Record<string, unknown>
  const summary_en = str(d.summary_en)
  const summary_ur = str(d.summary_ur)
  // prompt asks for <= 8 words; the hard cap is looser so an Urdu headline is never cut mid-phrase
  const title_en = capWords(str(d.title_en), 12) || capWords(summary_en, 10)
  const title_ur = capWords(str(d.title_ur), 14) || capWords(summary_ur, 12) || title_en
  const draft: IntakeDraft = {
    category: isCategory(d.category) ? d.category : 'other',
    urgency: isUrgency(d.urgency) ? d.urgency : 'medium',
    title_en,
    title_ur,
    summary_en: summary_en || title_en,
    summary_ur: summary_ur || title_ur,
  }

  const updates = attributeUpdates(r.attributes)
  return {
    reply_en,
    reply_ur,
    quick_replies: rekeyYesNoChips(sanitizeQuickReplies(r.quick_replies), input.attributes ?? {}, updates, reply_en),
    attributes: mergeAttributes(input.attributes ?? {}, updates, input.quickReply),
    draft,
    ready: r.ready === true,
    emergency: r.emergency === true,
    ask_photo: r.ask_photo === true && !input.hasImage,
    off_topic: r.off_topic === true,
  }
}

// ----------------------------------------------------------------------- streamed Responses call (intake only)

function scrubSecrets(s: string): string {
  return s.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, 'sk-***').replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
}

interface StreamJsonOpts {
  timeoutMs: number
  label: string
  maxOutputTokens: number
  effort: 'none' | 'low'
  /** called with the accumulated output text of the (non-commentary) message after every delta */
  onText?: (text: string) => void
}

/**
 * Responses API, strict json_schema, `stream: true`. Same contract as openai.ts responsesJson (no temperature,
 * store:false, phase-aware final text via outputText) but text deltas are surfaced while the model writes, so the
 * caller can start work (TTS) on the first fields before the whole object is done. Deltas of an item whose
 * phase is "commentary" are ignored (gpt-6-luna effort "none" quirk). No retry here: withFallback switches model.
 */
async function responsesJsonStream<T>(
  model: string,
  instructions: string,
  userContent: InputContent[],
  schemaName: string,
  schema: Record<string, unknown>,
  opts: StreamJsonOpts,
): Promise<{ data: T; usage?: Usage }> {
  const key = Deno.env.get('OPENAI_API_KEY')?.trim()
  if (!key) throw new OpenAIError('OPENAI_API_KEY is not configured', 0, 'no_key')
  const label = opts.label
  const ctrl = new AbortController()
  const timeoutErr = new OpenAIError(`openai ${label}: timed out after ${opts.timeoutMs} ms`, 0, 'timeout')
  const timer = setTimeout(() => ctrl.abort(timeoutErr), opts.timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(`${OPENAI_BASE}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model,
          instructions,
          input: [{ role: 'user', content: userContent }],
          reasoning: { effort: opts.effort },
          text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
          max_output_tokens: opts.maxOutputTokens,
          store: false,
          stream: true,
        }),
        signal: ctrl.signal,
      })
    } catch (e) {
      if (ctrl.signal.aborted) throw timeoutErr
      throw new OpenAIError(`openai ${label}: network error ${scrubSecrets(errText(e))}`, 0, 'network')
    }
    if (!res.ok) {
      let message = res.statusText || 'request failed'
      let code: string | undefined
      try {
        const body = await res.text()
        try {
          const j = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } }
          if (j.error?.message) message = j.error.message
          code = j.error?.code ?? j.error?.type ?? undefined
        } catch {
          if (body) message = body.slice(0, 300)
        }
      } catch { /* unreadable body */ }
      throw new OpenAIError(`openai ${label} ${res.status}: ${scrubSecrets(message)}`, res.status, code)
    }
    if (!res.body) throw new OpenAIError(`openai ${label}: empty stream`, 0, 'empty')

    const phases = new Map<string, string | undefined>()
    const texts = new Map<string, string>()
    let final: unknown = null
    let streamError: OpenAIError | null = null
    const handle = (data: string) => {
      if (!data || data === '[DONE]') return
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }
      const type = String(ev.type ?? '')
      if (type === 'response.output_item.added') {
        const item = ev.item as { id?: string; phase?: string } | undefined
        if (item?.id) phases.set(item.id, item.phase)
      } else if (type === 'response.output_text.delta') {
        const id = String(ev.item_id ?? `#${ev.output_index ?? 0}`)
        if (phases.get(id) === 'commentary') return
        const t = (texts.get(id) ?? '') + String(ev.delta ?? '')
        texts.set(id, t)
        try {
          opts.onText?.(t)
        } catch (e) {
          console.warn(`[ai] ${label} onText failed`, errText(e))
        }
      } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        final = ev.response ?? null
      } else if (type === 'error') {
        const err = (ev.error ?? ev) as { message?: string; code?: string }
        streamError = new OpenAIError(`openai ${label}: stream error ${scrubSecrets(String(err.message ?? ''))}`, 0, err.code ?? 'stream_error')
      }
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value.replace(/\r/g, '')
      let cut: number
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        handle(block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
      }
      if (streamError) throw streamError
    }
    if (buf.trim()) handle(buf.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n'))
    if (streamError) throw streamError
    if (!final) throw new OpenAIError(`openai ${label}: stream ended without a response`, 0, 'incomplete')

    const resp = final as Parameters<typeof outputText>[0]
    const text = outputText(resp, label) // phase-aware: final_answer message, never the commentary item
    try {
      return { data: JSON.parse(text) as T, usage: resp.usage }
    } catch {
      const a = text.indexOf('{')
      const b = text.lastIndexOf('}')
      if (a >= 0 && b > a) {
        try {
          return { data: JSON.parse(text.slice(a, b + 1)) as T, usage: resp.usage }
        } catch { /* fall through */ }
      }
      throw new OpenAIError(`openai ${label}: output is not valid JSON`, 0, 'bad_json')
    }
  } catch (e) {
    if (e instanceof OpenAIError) throw e
    if (ctrl.signal.aborted) throw timeoutErr
    throw new OpenAIError(`openai ${label}: ${scrubSecrets(errText(e))}`)
  } finally {
    clearTimeout(timer)
  }
}

const RE_REPLY_EN = /"reply_en"\s*:\s*"((?:[^"\\]|\\.)*)"/
const RE_REPLY_UR = /"reply_ur"\s*:\s*"((?:[^"\\]|\\.)*)"/
const RE_FLAG = (name: string) => new RegExp(`"${name}"\\s*:\\s*(true|false)`)
const RE_EMERGENCY = RE_FLAG('emergency')
const RE_READY = RE_FLAG('ready')
const RE_OFF_TOPIC = RE_FLAG('off_topic')

/** The reply as soon as it is complete in the stream (identical to the final reply unless the model is switched). */
export interface IntakeEarlyReply { en: string; ur: string; emergency: boolean; ready: boolean; off_topic: boolean; model: string }

/**
 * One intake turn: ONE strict-JSON Responses call (MODELS.reason primary -> fallback), streamed.
 * `onReply` fires once per model attempt as soon as reply_en + reply_ur are complete (the schema puts them first),
 * so the caller can run TTS while the draft + attributes are still being written. Turn / ready rules are enforced
 * by the caller (report-chat), which must compare the final reply with what it already sent to TTS.
 */
export async function intakeTurn(
  input: IntakeTurnInput,
  opts: { onReply?: (early: IntakeEarlyReply) => void } = {},
): Promise<{ data: IntakeTurnResult; meta: AiMeta }> {
  const content: InputContent[] = [{ type: 'input_text', text: buildIntakeInput(input) }]
  const { value, meta } = await withFallback('intake', MODELS.reason, async (model, isFallback) => {
    const t0 = Date.now()
    let fired = false
    let replyMs = 0
    const { data, usage } = await responsesJsonStream(model, INTAKE_INSTRUCTIONS, content, 'intake', INTAKE_SCHEMA, {
      timeoutMs: INTAKE_TIMEOUT_MS,
      label: `intake:${model}`,
      maxOutputTokens: 2500,
      effort: INTAKE_EFFORT,
      onText: (t) => {
        if (fired || !opts.onReply) return
        const en = RE_REPLY_EN.exec(t)
        const ur = RE_REPLY_UR.exec(t)
        if (!en || !ur) return
        fired = true
        replyMs = Date.now() - t0
        try {
          const pair = cleanReplyPair(JSON.parse(`"${en[1]}"`), JSON.parse(`"${ur[1]}"`), !isFallback)
          opts.onReply({
            ...pair,
            emergency: RE_EMERGENCY.exec(t)?.[1] === 'true',
            ready: RE_READY.exec(t)?.[1] === 'true',
            off_topic: RE_OFF_TOPIC.exec(t)?.[1] === 'true',
            model,
          })
        } catch { /* invalid early reply: the final parse decides (and may switch model) */ }
      },
    })
    console.log(
      `[ai] intake ${model} effort=${INTAKE_EFFORT} reply@${replyMs || '-'}ms done@${Date.now() - t0}ms in=${usage?.input_tokens ?? '?'} out=${usage?.output_tokens ?? '?'}`,
    )
    return sanitizeIntake(data, input, !isFallback)
  })
  return { data: value, meta }
}

// ======================================================================= extractProfile (Phase 1b voice onboarding)

export interface ProfileExtraction {
  /** as said, in its original script; null when no name was said */
  display_name: string | null
  /** normalised English form, e.g. "G-9/4, Islamabad"; null when no area was said */
  home_area: string | null
  /** 'en' / 'ur' (stated preference, else the language they spoke); null when unclear */
  language: 'ur' | 'en' | null
  /** Urdu-script renderings for the Urdu read-back sentence (fall back to the originals) */
  display_name_ur: string | null
  home_area_ur: string | null
}

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['display_name', 'display_name_ur', 'home_area', 'home_area_ur', 'language'],
  properties: {
    display_name: { type: ['string', 'null'] },
    display_name_ur: { type: ['string', 'null'] },
    home_area: { type: ['string', 'null'] },
    home_area_ur: { type: ['string', 'null'] },
    language: { type: ['string', 'null'], enum: ['ur', 'en', null] },
  },
}

const PROFILE_INSTRUCTIONS = `A phone app in Islamabad / Rawalpindi, Pakistan asked a new user: "Tell us your name and the area you live in." You get their answer: a speech-to-text transcript (may be noisy) or typed text, in Urdu script, Roman Urdu, Punjabi or English. Return JSON:
- display_name: the person's own name exactly as they gave it, in the SAME script it is written in (Urdu script stays Urdu script; Latin stays Latin, capitalised). Drop "mera naam", "my name is", "main", "hai" and polite words like "ji" / "sahab" unless part of the name. null if they gave no name.
- display_name_ur: the same name in Urdu script (null if no name).
- home_area: the area in standard English form "<sector or area>, <city>", e.g. "G-9/4, Islamabad", "F-7 Markaz, Islamabad", "I-8, Islamabad", "Satellite Town, Rawalpindi", "Bahria Town Phase 7, Rawalpindi", "Saddar, Rawalpindi". Islamabad sectors are a letter + number (+ /sub-sector): "جی نائن فور", "G nine four", "g9 4" -> "G-9/4"; "ایف سیون" -> "F-7". Add the city when it is clear (Islamabad sectors A-I letters -> Islamabad). null if they gave no area.
- home_area_ur: the same area in Urdu script, e.g. "جی نائن فور، اسلام آباد" (null if no area).
- language: "en" if they spoke English or asked for English; "ur" if they spoke Urdu / Roman Urdu / Punjabi or asked for Urdu; null if unclear.
Never invent a name or area that was not said. Ignore greetings and filler.`

function cleanField(v: unknown, maxWords: number): string | null {
  const s = str(v).replace(/^["'“”]+|["'“”.،۔]+$/g, '').trim()
  if (!s || /^(null|none|unknown|n\/a)$/i.test(s)) return null
  return capWords(s, maxWords).slice(0, 80)
}

/** Name + home area + language from the onboarding answer (strict JSON; null for anything not said). */
export async function extractProfile(text: string, opts: { uiLanguage?: 'ur' | 'en' } = {}): Promise<{ data: ProfileExtraction; meta: AiMeta }> {
  const said = str(text).slice(0, 1000)
  if (!said) throw new AiError('profile', 'empty text')
  const content: InputContent[] = [{
    type: 'input_text',
    text: `App language: ${opts.uiLanguage === 'en' ? 'English' : 'Urdu'}\nAnswer: """${said}"""`,
  }]
  const { value, meta } = await withFallback('profile', MODELS.reason, async (model) => {
    const { data } = await responsesJson<Record<string, unknown>>(model, PROFILE_INSTRUCTIONS, content, 'profile', PROFILE_SCHEMA, {
      timeoutMs: PROFILE_TIMEOUT_MS,
      label: `profile:${model}`,
      maxOutputTokens: 800,
      effort: INTAKE_EFFORT,
    })
    if (!data || typeof data !== 'object') throw new Error('profile output is not an object')
    const display_name = cleanField(data.display_name, 5)
    const home_area = cleanField(data.home_area, 8)?.replace(/\s*,\s*/g, ', ') ?? null
    const nameUr = cleanField(data.display_name_ur, 5)
    const areaUr = cleanField(data.home_area_ur, 8)
    const result: ProfileExtraction = {
      display_name,
      home_area,
      language: data.language === 'en' || data.language === 'ur' ? data.language : null,
      display_name_ur: display_name ? (nameUr && hasUrdu(nameUr) ? nameUr : display_name) : null,
      home_area_ur: home_area ? (areaUr && hasUrdu(areaUr) ? areaUr : home_area) : null,
    }
    return result
  })
  return { data: value, meta }
}
