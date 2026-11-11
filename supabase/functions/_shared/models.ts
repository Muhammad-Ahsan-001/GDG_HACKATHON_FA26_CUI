// THE single place for every AI model ID (checked against OpenAI + Gemini docs on 2026-11-11;
// research notes: docs/research/openai.md, docs/research/gemini.md).
//
// Policy (user decision): OpenAI (paid) runs EVERY task. Each task has an OpenAI `primary` and an OpenAI
// `fallback` that is tried automatically when the primary fails (timeout / 429 / 5xx / bad output).
// `gemini` lists the Gemini fallback model for each task — documented only, NOT wired yet
// (search for GEMINI_FALLBACK_HOOK in ai.ts; the user will ask for it to be enabled at the very end).

export const OPENAI_BASE = 'https://api.openai.com/v1'
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export const MODELS = {
  /** Voice notes (Urdu / Punjabi / English) -> text. POST /audio/transcriptions */
  stt: {
    primary: 'gpt-transcribe',            // current recommended STT, multi-language hints (languages[])
    fallback: 'gpt-4o-transcribe',        // deprecated (shutdown 2027-02-26) but still served; single `language`
    gemini: 'gemini-3.8-flash',           // audio understanding via generateContent (gemini-3.5-transcribe lacks ur-PK)
  },
  /** Report extraction -> strict JSON (category, urgency, bilingual summary, location hints, spam flag). POST /responses */
  extract: {
    primary: 'gpt-6-luna',                // most efficient GPT-6, structured outputs; reasoning.effort "low"
    fallback: 'gpt-6.1-terra',
    gemini: 'gemini-3.8-flash',
  },
  /** Photo check: does the photo match the claim, severity, food type + servings. POST /responses with input_image */
  vision: {
    primary: 'gpt-6.1-terra',             // visual-reasoning tuned GPT-6.1
    fallback: 'gpt-6-luna',
    gemini: 'gemini-3.8-flash',
  },
  /** Duplicate matching embeddings of the canonical English summary. POST /embeddings (dimensions: 1536) */
  embed: {
    primary: 'text-embedding-3-large',    // best multilingual OpenAI embedding; shortened to 1536 dims for HNSW
    fallback: 'text-embedding-3-large',   // same model on retry: vectors from different models are not comparable
    gemini: 'gemini-embedding-001',       // outputDimensionality 1536 (stored with embedding_model, never mixed)
    dimensions: 1536,
  },
  /** Gray-zone "same incident?" adjudication + verification confidence score. POST /responses */
  reason: {
    primary: 'gpt-6-luna',
    fallback: 'gpt-6.1-terra',
    gemini: 'gemini-3.8-flash',
  },
  /** Area digest + daily responder summary (bilingual). POST /responses */
  digest: {
    primary: 'gpt-6-luna',
    fallback: 'gpt-6.1-terra',
    gemini: 'gemini-3.5-flash-lite',
  },
  /** Read summaries / alerts aloud. POST /audio/speech */
  tts: {
    primary: 'gpt-4o-mini-tts',           // only REST TTS model left; deprecated, shutdown 2027-01-06; supports Urdu + instructions
    fallback: 'tts-1',
    gemini: null,                         // no Gemini TTS fallback (preview TTS models shut down 2026-11-17)
    voice: 'marin',
  },
} as const

/** Reasoning effort for GPT-6 Responses calls (never send temperature with effort != "none"). */
export const REASONING_EFFORT = 'low' as const
