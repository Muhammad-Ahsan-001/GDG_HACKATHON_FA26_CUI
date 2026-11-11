// Low-level OpenAI REST wrappers (Responses, transcriptions, embeddings, speech).
// Every call: hard timeout via AbortController (covers retry + body read), one retry on 429/5xx/network
// errors honouring Retry-After (capped at 3 s), store:false, and error messages that never contain the key.
// Higher-level task logic (prompts, schemas, model fallback) lives in ./ai.ts — import that, not this.

import { OPENAI_BASE, REASONING_EFFORT } from './models.ts'

export class OpenAIError extends Error {
  /** HTTP status, or 0 for network / timeout / client-side errors */
  status: number
  /** OpenAI error code (e.g. 'insufficient_quota') or a local code: 'no_key' | 'timeout' | 'network' | 'bad_json' | 'incomplete' | 'refusal' | 'empty' */
  code?: string
  constructor(message: string, status = 0, code?: string) {
    super(message)
    this.name = 'OpenAIError'
    this.status = status
    this.code = code
  }
  /** Errors where retrying with another OpenAI model cannot help (missing / invalid key). */
  get fatal(): boolean {
    return this.code === 'no_key' || this.status === 401
  }
}

export interface CallOpts {
  /** total budget for the call including the retry */
  timeoutMs: number
  /** short label used in error messages / logs, e.g. 'extract' */
  label?: string
}

const RETRY_AFTER_CAP_MS = 3000

function apiKey(): string {
  const key = Deno.env.get('OPENAI_API_KEY')?.trim()
  if (!key) throw new OpenAIError('OPENAI_API_KEY is not configured', 0, 'no_key')
  return key
}

/** Remove anything that looks like a key from text we put into errors / logs. */
function scrub(s: string): string {
  return s.replace(/sk-[A-Za-z0-9_\-*]{4,}/g, 'sk-***').replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
}

function retryDelayMs(res: Response): number {
  const ra = res.headers.get('retry-after-ms') ?? null
  if (ra && !Number.isNaN(Number(ra))) return Math.min(Number(ra), RETRY_AFTER_CAP_MS)
  const h = res.headers.get('retry-after')
  if (h) {
    const secs = Number(h)
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS)
    const at = Date.parse(h)
    if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), RETRY_AFTER_CAP_MS))
  }
  return 600 + Math.floor(Math.random() * 400)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function errorFrom(res: Response, label: string): Promise<OpenAIError> {
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
  } catch {
    // body unreadable — keep statusText
  }
  return new OpenAIError(`openai ${label} ${res.status}: ${scrub(message)}`, res.status, code ?? undefined)
}

/**
 * POST to an OpenAI endpoint and read the result with `read`, all inside one timeout.
 * `makeBody` is called per attempt so FormData / strings are fresh on the retry.
 */
async function call<T>(
  path: string,
  makeBody: () => BodyInit,
  contentType: string | null,
  opts: CallOpts,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const label = opts.label ?? path
  const key = apiKey()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new OpenAIError(`openai ${label}: timed out after ${opts.timeoutMs} ms`, 0, 'timeout')), opts.timeoutMs)
  const started = Date.now()
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
        if (contentType) headers['Content-Type'] = contentType
        res = await fetch(`${OPENAI_BASE}${path}`, { method: 'POST', headers, body: makeBody(), signal: ctrl.signal })
      } catch (e) {
        if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof OpenAIError ? ctrl.signal.reason : new OpenAIError(`openai ${label}: aborted`, 0, 'timeout')
        if (attempt === 0 && opts.timeoutMs - (Date.now() - started) > 2000) {
          await sleep(400, ctrl.signal)
          continue
        }
        throw new OpenAIError(`openai ${label}: network error ${scrub(e instanceof Error ? e.message : String(e))}`, 0, 'network')
      }
      if (res.ok) {
        try {
          return await read(res)
        } catch (e) {
          if (ctrl.signal.aborted && ctrl.signal.reason instanceof OpenAIError) throw ctrl.signal.reason
          throw e
        }
      }
      const err = await errorFrom(res, label)
      const retryable = (res.status === 429 && err.code !== 'insufficient_quota' && err.code !== 'billing_hard_limit_reached') || res.status >= 500
      if (attempt === 0 && retryable) {
        const wait = retryDelayMs(res)
        // only retry if there is a realistic chance of finishing inside the budget
        if (opts.timeoutMs - (Date.now() - started) - wait > 2000) {
          await sleep(wait, ctrl.signal)
          continue
        }
      }
      throw err
    }
  } catch (e) {
    if (e instanceof OpenAIError) throw e
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof OpenAIError) throw ctrl.signal.reason
    throw new OpenAIError(`openai ${label}: ${scrub(e instanceof Error ? e.message : String(e))}`)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- Responses (strict JSON)

export type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' | 'original' }

export interface ResponsesOpts extends CallOpts {
  maxOutputTokens?: number
  effort?: 'none' | 'low' | 'medium' | 'high'
}

export interface Usage { input_tokens?: number; output_tokens?: number; total_tokens?: number }

interface ResponsesBody {
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  output?: {
    type: string
    phase?: string
    content?: { type: string; text?: string; refusal?: string }[]
  }[]
  usage?: Usage
}

/** Phase-aware extraction of the final assistant text (skips reasoning + 'commentary' message items). */
export function outputText(resp: ResponsesBody, label = 'responses'): string {
  if (resp.status === 'failed') throw new OpenAIError(`openai ${label}: response failed ${scrub(resp.error?.message ?? '')}`, 0, 'failed')
  const msgs = (resp.output ?? []).filter((i) => i.type === 'message')
  const msg = msgs.find((m) => m.phase === 'final_answer') ?? msgs.at(-1)
  if (!msg) {
    if (resp.status === 'incomplete') throw new OpenAIError(`openai ${label}: incomplete (${resp.incomplete_details?.reason ?? 'unknown'})`, 0, 'incomplete')
    throw new OpenAIError(`openai ${label}: no message in output`, 0, 'empty')
  }
  const refusal = msg.content?.find((c) => c.type === 'refusal')
  if (refusal) throw new OpenAIError(`openai ${label}: refusal ${refusal.refusal ?? ''}`.slice(0, 300), 0, 'refusal')
  const text = (msg.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('')
  if (!text.trim()) throw new OpenAIError(`openai ${label}: empty output`, 0, resp.status === 'incomplete' ? 'incomplete' : 'empty')
  return text
}

/**
 * Responses API with a strict json_schema output. Returns the parsed JSON (shape guaranteed by the schema;
 * callers still validate). Uses reasoning.effort (default 'low') and NO temperature.
 */
export async function responsesJson<T = unknown>(
  model: string,
  instructions: string,
  userContent: InputContent[],
  schemaName: string,
  schema: Record<string, unknown>,
  opts: ResponsesOpts,
): Promise<{ data: T; usage?: Usage }> {
  const label = opts.label ?? schemaName
  const body = JSON.stringify({
    model,
    instructions,
    input: [{ role: 'user', content: userContent }],
    reasoning: { effort: opts.effort ?? REASONING_EFFORT },
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
    max_output_tokens: opts.maxOutputTokens ?? 4000,
    store: false,
  })
  const resp = await call<ResponsesBody>('/responses', () => body, 'application/json', { ...opts, label }, (r) => r.json())
  const text = outputText(resp, label)
  try {
    return { data: JSON.parse(text) as T, usage: resp.usage }
  } catch {
    // tolerate stray prose/code fences around the JSON object
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s >= 0 && e > s) {
      try {
        return { data: JSON.parse(text.slice(s, e + 1)) as T, usage: resp.usage }
      } catch { /* fall through */ }
    }
    throw new OpenAIError(`openai ${label}: output is not valid JSON`, 0, 'bad_json')
  }
}

// ---------------------------------------------------------------- Speech-to-text

export interface TranscriptionParams {
  /** gpt-transcribe: several ISO-639-1 hints (sent as languages[]); never combined with `language` */
  languages?: string[]
  /** older models: one ISO-639-1 code */
  language?: string
  /** gpt-transcribe vocabulary hints (no <, >, CR, LF) */
  keywords?: string[]
  prompt?: string
}

export interface TranscriptionResult { text: string; languages: string[] }

export function audioExt(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (/mp4|m4a|aac/.test(m)) return 'm4a'
  if (m.includes('wav')) return 'wav'
  if (m.includes('flac')) return 'flac'
  return 'mp3'
}

export async function transcription(
  model: string,
  audio: Uint8Array,
  mime: string,
  params: TranscriptionParams,
  opts: CallOpts,
): Promise<TranscriptionResult> {
  const cleanMime = (mime || 'audio/webm').split(';')[0].trim() || 'audio/webm'
  const ext = audioExt(cleanMime)
  const bytes = new Uint8Array(audio) // own ArrayBuffer copy for Blob typing
  const makeBody = () => {
    const fd = new FormData()
    fd.append('file', new File([bytes], `note.${ext}`, { type: cleanMime }))
    fd.append('model', model)
    fd.append('response_format', 'json')
    if (params.languages?.length) for (const l of params.languages) fd.append('languages[]', l)
    else if (params.language) fd.append('language', params.language)
    for (const k of params.keywords ?? []) {
      const kw = k.replace(/[<>\r\n]/g, ' ').trim()
      if (kw) fd.append('keywords[]', kw)
    }
    if (params.prompt) fd.append('prompt', params.prompt)
    return fd
  }
  const label = opts.label ?? 'transcribe'
  const body = await call<{ text?: string; language?: string; languages?: { code?: string }[] }>(
    '/audio/transcriptions', makeBody, null, { ...opts, label }, (r) => r.json(),
  )
  const langs = (body.languages ?? []).map((l) => (l.code ?? '').toLowerCase()).filter(Boolean)
  if (!langs.length && body.language) langs.push(body.language.toLowerCase())
  return { text: (body.text ?? '').trim(), languages: langs }
}

// ---------------------------------------------------------------- Embeddings

export async function embeddings(model: string, input: string[], dimensions: number | undefined, opts: CallOpts): Promise<number[][]> {
  const body = JSON.stringify({ model, input, encoding_format: 'float', ...(dimensions ? { dimensions } : {}) })
  const label = opts.label ?? 'embed'
  const resp = await call<{ data?: { index: number; embedding: number[] }[] }>(
    '/embeddings', () => body, 'application/json', { ...opts, label }, (r) => r.json(),
  )
  const rows = [...(resp.data ?? [])].sort((a, b) => a.index - b.index)
  if (rows.length !== input.length) throw new OpenAIError(`openai ${label}: expected ${input.length} embeddings, got ${rows.length}`, 0, 'empty')
  return rows.map((r) => r.embedding)
}

// ---------------------------------------------------------------- Text-to-speech

export interface SpeechParams {
  voice: string
  instructions?: string
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav'
  speed?: number
}

export async function speech(model: string, input: string, params: SpeechParams, opts: CallOpts): Promise<Uint8Array> {
  const body = JSON.stringify({
    model,
    voice: params.voice,
    input: input.slice(0, 4096),
    response_format: params.format ?? 'mp3',
    ...(params.instructions ? { instructions: params.instructions.slice(0, 4096) } : {}),
    ...(params.speed ? { speed: params.speed } : {}),
  })
  const label = opts.label ?? 'tts'
  const audio = await call<Uint8Array>('/audio/speech', () => body, 'application/json', { ...opts, label }, async (r) => new Uint8Array(await r.arrayBuffer()))
  if (audio.byteLength < 100) throw new OpenAIError(`openai ${label}: empty audio`, 0, 'empty')
  return audio
}
