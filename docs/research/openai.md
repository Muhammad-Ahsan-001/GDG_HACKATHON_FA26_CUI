# OpenAI API for Awaaz: model choices and request shapes (checked 2026-11-11)

**Main finding:** the OpenAI lineup changed a lot after my training data. The current flagships are **`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`**. There are no "mini" or "nano" models in the current flagship family. **`gpt-5`, `gpt-5-mini` and `gpt-5-nano` shut down on 2026-12-11, so do not use them.** All of `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` are deprecated. Docs moved from `platform.openai.com/docs` to **`developers.openai.com/api/docs`** (the old URL returns a 301 redirect).

---

## 0. Recommended MODELS config

```ts
// supabase/functions/_shared/models.ts
export const MODELS = {
  stt:          "gpt-transcribe",          // POST /v1/audio/transcriptions, $0.0045/min
  extract:      "gpt-6-luna",              // text + image -> strict JSON; reasoning.effort "low"
  extractHard:  "gpt-6.1-terra",           // escalate for hard photos (visual reasoning), $1/$5
  flagship:     "gpt-6.1-sol",             // only if quality demands it, $2/$10 (Astra is $10/$50)
  embed:        "text-embedding-3-large",  // send dimensions: 1536 -> fits a pgvector HNSW index
  tts:          "gpt-4o-mini-tts",         // deprecated, works until 2027-01-06; voice "marin"
} as const;
export const OPENAI_BASE = "https://api.openai.com/v1";
```

Why each one:
- **STT, `gpt-transcribe`:** it is the only non-deprecated model for file transcription and OpenAI recommends it. It is also cheaper than its predecessor ($0.0045/min vs $0.006/min).
  - It accepts several language hints at once (`languages[]`), which suits Urdu/Punjabi/English code-switching. It also takes `keywords[]` and `prompt`.
  - Use `gpt-live-transcribe` (Realtime) only for live microphone streaming; it does not fit voice notes.
- **Extraction, `gpt-6-luna`:** text and image input, structured outputs, and both Responses and Chat Completions.
  - Price: $0.10 per 1M input tokens and $0.50 per 1M output tokens, about 20x cheaper than Sol.
  - It supports `reasoning.effort` `none` through `max`. Use `"low"`, not `"none"`, because of a structured-output bug reported at `none` (see the gotchas in section 2).
- **Embeddings, `text-embedding-3-large` with `dimensions: 1536`:** it is still the newest embedding model; the docs list nothing after v3. OpenAI calls it "most capable … for both english and non-english tasks".
  - Its multilingual retrieval score (MIRACL) is clearly above `-3-small`. The cost difference ($0.13 vs $0.02 per 1M tokens) does not matter at hackathon scale.
  - At 1536 dimensions it fits `vector(1536)`, and pgvector HNSW indexes on `vector` are capped at 2000 dimensions.
- **TTS, `gpt-4o-mini-tts`:** it is the only remaining REST text-to-speech model, it supports `instructions`, and Urdu is on its language list. It is deprecated with shutdown on 2027-01-06, after the hackathon. Post-shutdown replacements are in section 4.

---

## 1. Speech-to-text (Urdu / Punjabi / English voice notes)

**Endpoint:** `POST https://api.openai.com/v1/audio/transcriptions` (multipart/form-data)

**Models:**

| model | status | price | notes |
|---|---|---|---|
| `gpt-transcribe` | current, recommended (launched 2026-07-28) | $0.0045/min | `languages[]` (multiple), `keywords[]`, `prompt`, `stream` |
| `gpt-live-transcribe` | current | $0.017/min | for live streams, used through Realtime transcription sessions |
| `gpt-realtime-whisper` | current | not checked | Realtime only |
| `gpt-4o-transcribe` | deprecated, shuts down 2027-02-26 | about $0.006/min ($2.50/$10 per 1M tokens) | `language` takes one value; `response_format` is `json` only |
| `gpt-4o-mini-transcribe` (and `-2025-12-15`) | deprecated, shuts down 2027-02-26 | about $0.003/min | `json` only |
| `gpt-4o-transcribe-diarize` | deprecated, shuts down 2027-02-26 | not checked | `diarized_json`; no `prompt` |
| `whisper-1` | deprecated, shuts down 2027-02-26 | $0.006/min | only model with `srt`/`vtt`/`verbose_json` and word timestamps; no streaming; prompt limited to 224 tokens |

**Accuracy (OpenAI's own figures):** real-world error rate is 8.98% for `gpt-transcribe` vs 15.21% for `whisper-1`. Artificial Analysis AA-WER puts `gpt-transcribe` at 3.31%, about 0.7 points better than `gpt-4o-transcribe`. Independent testers say it still trails ElevenLabs Scribe v2, Gemini 3 Pro and Voxtral. Sources: gigazine, the-decoder.

**Urdu and Punjabi support (not verified):**
- OpenAI publishes **no language list for `gpt-transcribe`**. The guide only says it accepts ISO 639-1 codes, selected ISO 639-3 codes and `zh-*`, and that "The API rejects unsupported or incorrectly formatted language codes."
- **Urdu** (`ur`) is on OpenAI's official list of roughly 57 languages "following Whisper" (shown on the TTS page). **Punjabi is NOT on that list.** It exists only among Whisper's 98 training languages (`"pa": "punjabi"` in Whisper's `tokenizer.py`).
- Expect Urdu to be OK and Punjabi to be weak. Pakistani Punjabi written in Shahmukhi script will probably come back as Urdu-script or Gurmukhi text.
- **Test `languages[]=pa` on day 1.** If it returns 400, fall back to `["ur","en"]`.
- There are no per-language benchmarks for `gpt-transcribe` in Urdu or Punjabi. A Soniox vendor benchmark quotes OpenAI Urdu WER at 17.9%; treat that as marketing.

**File formats and size:**
- The guide lists mp3, mp4, mpeg, mpga, m4a, wav, webm. The API reference adds **flac and ogg**.
- **The maximum is 25 MB per file.** Larger files must be split or compressed, so cap voice notes at about 10 minutes of opus.

**Parameters:**
- `file`: a filename with the right extension is recommended, plus a matching content type.
- `model`
- `languages[]` (`gpt-transcribe` only; it replaces `language`, and you must not send both).
- `language` (older models, one ISO-639-1 code).
- `prompt`: should be written in the audio's language. Not supported on diarize. A prompt that is too long rejects the whole request. A third-party source (Vapi) says the limit is 8192 characters for `gpt-transcribe` and 1024 for the 4o models; not verified.
- `keywords[]`: no `<`, `>`, CR or LF characters.
- `response_format`: default `json`. Allowed values are `json|text|srt|verbose_json|vtt|diarized_json`, but the 4o models accept **json only**. Which values `gpt-transcribe` accepts is **not documented**, so use `json`.
- `temperature`: 0 to 1, default 0.
- `timestamp_granularities[]`: `whisper-1` with `verbose_json` only.
- `chunking_strategy`
- `include[]=logprobs`: 4o models only.
- `stream=true`: Server-Sent Events, not on `whisper-1`.

**Response for `gpt-transcribe` with `json`:**
```json
{
  "text": "…",
  "languages": [{ "code": "ur" }],
  "usage": { "type": "duration", "seconds": 12.3 }
}
```
- `languages` is an empty array `[]` when no language is detected reliably.
- `usage` is either `{type:"tokens", input_tokens, output_tokens, total_tokens, input_token_details:{audio_tokens,text_tokens}}` or `{type:"duration", seconds}`.
- Stream events are `transcript.text.delta` and `transcript.text.done` (`{type, text, languages}`).

**Deno example:**
```ts
const KEY = Deno.env.get("OPENAI_API_KEY")!;
const extFor = (mime: string) =>
  mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" :
  /mp4|m4a|aac/.test(mime) ? "m4a" : mime.includes("wav") ? "wav" : "mp3";

export async function transcribe(audio: Blob, langs = ["ur", "pa", "en"]) {
  const mime = (audio.type || "audio/webm").split(";")[0];   // drop ";codecs=opus"
  const fd = new FormData();
  fd.append("file", new File([audio], `note.${extFor(mime)}`, { type: mime }));
  fd.append("model", "gpt-transcribe");
  for (const l of langs) fd.append("languages[]", l);          // bracket syntax, per the docs' cURL
  fd.append("keywords[]", "Awaaz");                            // optional: place names, ward names
  fd.append("response_format", "json");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },               // do NOT set Content-Type (boundary)
    body: fd,
  });
  if (r.status === 400 && langs.includes("pa")) return transcribe(audio, ["ur", "en"]); // 'pa' may be rejected
  if (!r.ok) throw new Error(`stt ${r.status}: ${await r.text()}`);
  return await r.json() as { text: string; languages?: { code: string }[] };
}
```

**Gotchas:**
- Strip `;codecs=opus` from the MIME type and make the filename extension match the actual container.
- iOS Safari's MediaRecorder produces `audio/mp4`. Older (Whisper-era) community threads report "Invalid file format" or garbage output for Safari mp4. The reported workarounds are `mediaRecorder.start(1000)` with a timeslice, or transcoding. This is anecdotal and not retested with `gpt-transcribe`, so test early on a real iPhone.
- `/v1/audio/translations` (to English) is deprecated with shutdown 2027-02-26. For an English version of a note, translate the transcript with the LLM instead.

---

## 2. Structured JSON extraction with image input

**Current text models:**

| model | input $/1M | cached input | output $/1M | `reasoning.effort` | default | knowledge cutoff | context / max output |
|---|---|---|---|---|---|---|---|
| `gpt-6-astra` (top flagship) | 10 | 1 | 50 | low…max (**no `none`**) | not stated | 2026-04-30 | 1.05M / 128k |
| `gpt-6.1-sol` | 2 | 0.10 | 10 | low…max (**no `none` or `minimal`**) | medium | 2026-04-30 | 1.05M / 128k |
| `gpt-6.1-terra` (visual reasoning) | 1 | 0.05 | 5 | none…max | medium | 2026-06-01 | 1.05M / 128k |
| `gpt-6-luna` (most efficient) | 0.10 | 0.01 | 0.50 | none, low, medium, high, xhigh, max | medium | 2026-05-18 | 1.05M / 128k |

- All four take text and image input, produce text only, and work on Responses, Chat Completions and Batch. All support structured outputs and image input.
- Batch and Flex are 50% off. Prompts over 272k input tokens cost 2x on input and 1.5x on output.
- Older models still available: `gpt-5.6-sol/terra/luna`, `gpt-5.5`, `gpt-5.4-mini` and `gpt-6-sol`.
- **Deprecated:** `gpt-5`, `gpt-5-mini`, `gpt-5-nano` (shut down 2026-12-11), and `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` (shut down 2027-01-14, replacement `gpt-6-luna`).

**Reasoning and sampling rules** (from the latest-model guide):
- **When effort is not `none`, remove `temperature`, `top_p` and `top_logprobs`.** On Chat Completions also remove `logprobs`.
- The default effort is `medium`, so **sending `temperature` without `effort:"none"` causes an error.** A third-party source quotes the message as "Unsupported parameter: 'temperature'…".
- Astra and Sol never accept `none`; sending it returns HTTP 400.
- On Chat Completions, Astra, 6.1 Sol and 6.1 Terra cannot do function calling at all; Luna and 6 Sol can only with `reasoning_effort:"none"`. Use Responses for tools.
- Other Responses parameters:
  - `reasoning.summary`: `auto|concise|detailed`.
  - `reasoning.mode`: `standard|pro`.
  - `text.verbosity`: `low|medium|high`.
  - `max_output_tokens`: minimum 16, and it includes reasoning tokens.
  - `store` defaults to **true**, so send `store:false`.
  - `safety_identifier`: at most 128 characters; use a hashed user ID.

**Image input:**
- Formats: PNG, JPEG, WEBP and non-animated GIF. **HEIC is not listed**, so convert iPhone photos to JPEG on the client with a canvas.
- Limits: 512 MB per request, 1,500 images, 30,000 patches per image (larger images are rejected, not resized).
- `detail`: `auto` (default), `low`, `high`, `original`.
- Cost on GPT-6 models is based on 32 px patches. For Astra a 1024×1024 image at `high` costs about 1,229 tokens. Luna's multiplier is not stated.
- `image_url` can be an https URL or a `data:image/jpeg;base64,...` data URL; `file_id` is also accepted.
- A Supabase signed URL must be publicly fetchable by OpenAI and must not expire before the call. A base64 data URL is the safer choice.

**Responses API: `POST https://api.openai.com/v1/responses`**
```ts
import { encodeBase64 } from "jsr:@std/encoding/base64";

const schema = {
  type: "object", additionalProperties: false,
  required: ["category", "severity", "summary_en", "summary_ur", "location_hint", "is_civic_issue"],
  properties: {
    category: { type: "string", enum: ["roads", "water", "sanitation", "electricity", "safety", "other"] },
    severity: { type: "integer", minimum: 1, maximum: 5 },
    summary_en: { type: "string" },
    summary_ur: { type: "string" },
    location_hint: { type: ["string", "null"] },       // optional = union with null; still listed in required
    is_civic_issue: { type: "boolean" },
  },
};

export async function extract(transcript: string, img?: Uint8Array, imgMime = "image/jpeg") {
  const content: unknown[] = [{ type: "input_text", text: `Voice note transcript:\n${transcript}` }];
  if (img) content.push({ type: "input_image", image_url: `data:${imgMime};base64,${encodeBase64(img)}`, detail: "auto" });
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-luna",
      instructions: "Extract a civic complaint from Urdu/Punjabi/English input. Output only the schema.",
      input: [{ role: "user", content }],
      reasoning: { effort: "low" },          // no temperature/top_p when effort != "none"
      text: { format: { type: "json_schema", name: "complaint", strict: true, schema } },
      max_output_tokens: 4000,
      store: false,
    }),
  });
  const resp = await r.json();
  if (!r.ok) throw new Error(`responses ${r.status}: ${JSON.stringify(resp.error)}`);
  return JSON.parse(outputText(resp));
}

// Raw REST: don't rely on resp.output_text (the reference says to use it "where supported in SDKs").
export function outputText(resp: any): string {
  if (resp.status === "incomplete") throw new Error(`incomplete: ${resp.incomplete_details?.reason}`);
  const msgs = (resp.output ?? []).filter((i: any) => i.type === "message");
  const msg = msgs.find((m: any) => m.phase === "final_answer") ?? msgs.at(-1);  // skip "commentary"
  if (!msg) throw new Error("no message item");
  const refusal = msg.content.find((c: any) => c.type === "refusal");
  if (refusal) throw new Error(`refusal: ${refusal.refusal}`);
  return msg.content.filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
}
```

**Response shape:**
- `{ id, status: "completed"|"incomplete"|…, output: [ {type:"reasoning",…}?, {type:"message", role:"assistant", phase:"commentary"|"final_answer", content:[{type:"output_text", text, annotations}|{type:"refusal", refusal}]} ], incomplete_details:{reason: "max_output_tokens"|"content_filter"|"max_messages"|"steered"}, usage:{…} }`
- The docs say: "It is not safe to assume that the model's text output is present at `output[0].content[0].text`."
- I did not see the exact `usage` field names in the reference. I expect `input_tokens`, `output_tokens` and `output_tokens_details.reasoning_tokens`, but did not confirm them.

**Chat Completions equivalent: `POST https://api.openai.com/v1/chat/completions`**
```ts
body: JSON.stringify({
  model: "gpt-6-luna",
  messages: [
    { role: "developer", content: "Extract a civic complaint…" },
    { role: "user", content: [
      { type: "text", text: transcript },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "auto" } },
    ]},
  ],
  reasoning_effort: "low",
  response_format: { type: "json_schema", json_schema: { name: "complaint", strict: true, schema } },
  max_completion_tokens: 4000,          // max_tokens is deprecated
})
// read it: const m = (await r.json()).choices[0].message;
//   if (m.refusal) …; JSON.parse(m.content); check choices[0].finish_reason === "length"
```
- `json_schema.name` may only contain a-z, A-Z, 0-9, `_` and `-`, at most 64 characters.
- `reasoning_effort` accepts `none|minimal|low|medium|high|xhigh|max` and defaults to `medium`.
- `verbosity` accepts `low|medium|high`.

**Strict-mode schema rules:**
- Every object needs `additionalProperties:false`, and **every property must be listed in `required`**. Make a field optional with a type like `["string","null"]`.
- The root must be an object, not `anyOf`.
- Not supported: `allOf`, `not`, `if`/`then`/`else`, `dependent*`.
- Limits: 5,000 properties in total, nesting up to 10 levels, 1,000 enum values in total, and 120,000 characters of names plus enum and const values.
- Supported keywords: `pattern`, `format` (`date-time`, `email`, `uuid`, …), `minimum`/`maximum`, `minItems`/`maxItems`.
- JSON mode (`{type:"json_object"}`) gives no schema guarantee and needs the word "JSON" in the prompt.

**Gotchas:**
- **Extra message bug** (community thread 1401886, Sept–Oct 2026, no fix): `gpt-6-luna` with `effort:"none"`, `temperature` set and strict `json_schema` sometimes, about 3–5% of calls, returns an **extra message item with `phase:"commentary"`**. That breaks `output_text` and the SDK `parse()` helper. The reporter said the schema `name` affected the rate, with snake_case names like `remark_filing` worse than `answer`. Fix it by using `effort:"low"`, sending no temperature, and parsing with the phase-aware helper above.
- **Truncation:** if `max_output_tokens` is too small, reasoning can use up the budget. You then get `status:"incomplete"` and possibly no message at all. OpenAI suggests reserving about 25k tokens while experimenting; 4k is fine for small schemas at `low` effort.
- **Prompt caching:** the GPT-6 parameter is `prompt_cache_options.ttl` (`"30m"`/`"12h"`); it replaces `prompt_cache_retention`.

---

## 3. Embeddings

**Endpoint:** `POST https://api.openai.com/v1/embeddings`
- Models: `text-embedding-3-large` (3072 dims by default, $0.13/1M), `text-embedding-3-small` (1536 dims by default, $0.02/1M), and `text-embedding-ada-002` (legacy). **Nothing newer is in the official docs.** "text-embedding-4" listings on aggregator sites are not real.
- `dimensions` works on text-embedding-3 and later. It shortens the vector; per the guide, 3-large shortened to 256 dimensions still beats ada-002 on MTEB.
- `encoding_format` is `float` (default) or `base64`.
- Limits: 8,192 tokens per input, at most 2,048 inputs per array, 300,000 tokens per request.

**Benchmarks:**
- MTEB: 64.6 for 3-large, 62.3 for 3-small, 61.0 for ada-002 (official guide).
- MIRACL, a multilingual retrieval benchmark: 54.9 for 3-large vs 31.4 for ada-002 (secondary sources; openai.com returned 403). The 44.0 figure for 3-small could not be verified.
- **There are no Urdu-specific or Urdu–English cross-lingual numbers.** The docs only say 3-large is "most capable … for both english and non-english tasks". Check retrieval quality on your own Urdu/English complaint pairs.

**Rate limits for 3-large** (RPM / TPM): Free 100 RPM, 2,000 RPD, 40k TPM; Build 5,000 / 1M; Launch 10,000 / 5M; Grow 10,000 / 10M.

```ts
const r = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "text-embedding-3-large", input: [textEnOrUr], dimensions: 1536 }),
});
const { data } = await r.json();          // data[i].embedding: number[] (1536), data[i].index
```

**pgvector gotchas:**
- HNSW indexes on `vector` are capped at **2,000 dimensions**; `halfvec` goes up to 4,000 (pgvector 0.7 or later).
- So use `dimensions:1536` with `vector(1536)`, or keep 3072 and build the index on `(embedding::halfvec(3072)) halfvec_cosine_ops`, as the Supabase docs show.
- Use cosine distance (`<=>`).
- Store every row with the same model and the same dimensions.
- Consider embedding a combined "English summary + original text" string so cross-lingual matches are more robust; this is a design suggestion, not from the docs.

---

## 4. Text-to-speech

**Endpoint:** `POST https://api.openai.com/v1/audio/speech` (JSON body; the response is the binary audio).
- Models: `gpt-4o-mini-tts` (snapshots `-2025-12-15` (default) and `-2025-03-20`), `tts-1` and `tts-1-hd`. **All are deprecated with shutdown on 2027-01-06.** OpenAI's replacement is `gpt-realtime-2.1-mini` on the **Realtime API only**; it does not work on `/v1/audio/speech`.
- **There is no non-deprecated REST TTS model.**
- **REST fallback after shutdown:** `gpt-audio-1.5` on Chat Completions with `modalities:["text","audio"]` and `audio:{voice:"alloy",format:"wav"}`, reading the base64 audio from `choices[0].message.audio.data`. It is not deprecated.
  - Price: audio output $64/1M tokens, text $2.50 in and $10 out.
  - Its full voice and format list is not documented; only `alloy`/`wav` appear in examples.
- **Parameters:**
  - `input`: at most 4,096 characters.
  - `voice`: `alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar`. OpenAI recommends **`marin` or `cedar`** for best quality. `tts-1` supports only 9 of these. A custom voice object `{id:"voice_…"}` also works.
  - `instructions`: at most 4,096 characters; not on `tts-1` or `tts-1-hd`.
  - `response_format`: `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm` (24 kHz, 16-bit, no header).
  - `speed`: 0.25 to 4.0.
  - `stream_format`: `audio` or `sse` (`sse` not on `tts-1`).
- **Languages:** the list of about 60 languages "following Whisper" **includes Urdu (and Hindi), but not Punjabi.** Voices are tuned for English, so try an `instructions` line such as "Speak in natural Pakistani Urdu".
- **Price:** `gpt-4o-mini-tts` costs $0.60 per 1M text input tokens and $12 per 1M audio output tokens. `tts-1` is $15 and `tts-1-hd` $30 per 1M characters.
- **Rate limits** (RPM / TPM): Build 2,000 / 150k; Launch 10,000 / 2M; Grow 10,000 / 8M.

```ts
const r = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-4o-mini-tts", voice: "marin", input: urduText.slice(0, 4096),
    instructions: "Speak clearly in natural Pakistani Urdu, calm and reassuring.",
    response_format: "mp3",               // mp3 plays everywhere, iOS Safari included
  }),
});
if (!r.ok) throw new Error(await r.text());
return new Response(r.body, { headers: { "Content-Type": "audio/mpeg" } }); // stream it straight through
```

---

## 5. Rate limits and pricing summary

**Usage tiers** (new names):

| tier | qualifies with | monthly usage cap |
|---|---|---|
| Free | allowed geography | $100 |
| Build | $5 of credit purchases | $500 |
| Launch | $100 of credit purchases | $5k |
| Grow | $500 of credit purchases | $200k |

**Default rate limits on Build:**

| model | RPM / TPM |
|---|---|
| `gpt-6-luna` | 5,000 / 2M |
| `gpt-6.1-terra` | 5,000 / 1M |
| `gpt-6.1-sol` | 5,000 / 1M |
| `gpt-6-astra` | 5,000 / 1M |
| `gpt-transcribe` | 5,000 / 2M |
| `gpt-4o-mini-tts` | 2,000 / 150k |
| `text-embedding-3-large` | 5,000 / 1M |

**Handling 429s:**
- Response headers: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` and `Retry-After`.
- When you get a 429, wait at least `Retry-After` plus a little random jitter, then use exponential backoff.
- Don't retry quota or billing errors.

**Cost per complaint:**

| item | cost |
|---|---|
| 30 s voice note | about $0.0023 |
| Luna extraction (~2k in, 500 out, one image) | about $0.0005 |
| Embedding | about $0.00001 |
| TTS reply of ~300 characters | well under $0.01 (my estimate; not computed) |

The **Free tier is not listed for `gpt-6-luna`, `gpt-transcribe` or `gpt-4o-mini-tts`**; only the embedding page shows a Free row. Buy $5 of credit to reach Build.

---

## Could not verify

1. **Urdu/Punjabi support in `gpt-transcribe`:** there is no official language list, and Punjabi is absent from OpenAI's supported-language list. Test whether `languages[]=pa` is accepted or rejected with 400.
2. **`gpt-transcribe` response formats:** whether `text`, `verbose_json` or `srt` work is undocumented; only `json` is shown.
3. **`gpt-transcribe` prompt limit:** 8,192 characters comes from Vapi docs, not OpenAI.
4. **Audio format list:** the guide (mp3, mp4, mpeg, mpga, m4a, wav, webm) and the API reference (which adds flac and ogg) disagree.
5. **iOS Safari mp4 failures:** these are anecdotal and from the Whisper era.
6. **Responses details:** the raw REST `output_text` field and the exact `usage` field names were not confirmed in the reference.
7. **Embedding benchmarks:** MIRACL figures are from secondary sources, and there are no Urdu cross-lingual benchmarks.
8. **`gpt-audio-1.5`:** its voice and format lists are undocumented.
9. **Model pages:** the Astra page does not state a default reasoning effort, and Luna's image token multiplier is not stated.
10. **Free tier:** whether the GPT-6 models are available on it at all.

## Sources
- https://developers.openai.com/api/docs/models and https://developers.openai.com/api/docs/models/all
- https://developers.openai.com/api/docs/models/gpt-6-luna | gpt-6.1-terra | gpt-6.1-sol | gpt-6-astra | gpt-transcribe | gpt-4o-mini-tts | gpt-audio-1.5 | gpt-realtime-2.1-mini | text-embedding-3-large
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/api/docs/guides/speech-to-text (+ `.md`) and https://developers.openai.com/api/docs/guides/transcription
- https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
- https://developers.openai.com/api/docs/guides/text-to-speech (+ `.md`)
- https://developers.openai.com/api/docs/guides/audio-chat-completions.md
- https://developers.openai.com/api/docs/guides/latest-model and https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/text
- https://developers.openai.com/api/reference/resources/responses/methods/create
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- https://developers.openai.com/api/docs/guides/embeddings and https://developers.openai.com/api/reference/resources/embeddings/methods/create
- https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/guides/rate-limits
- https://community.openai.com/t/gpt-6-luna-occasionally-returns-an-additional-message-item-for-structured-outputs/1401886
- https://community.openai.com/t/gpt-live-transcribe-and-gpt-transcribe-two-new-transcription-models-in-the-api/1388318
- https://the-decoder.com/gpt-transcribe-improves-on-its-predecessor-but-cant-catch-elevenlabs-google-or-mistral-on-error-rates/
- https://gigazine.net/gsc_news/en/20260729-gpt-live-transcribe
- https://raw.githubusercontent.com/openai/whisper/main/whisper/tokenizer.py
- https://community.openai.com/t/whisper-api-cannot-read-files-correctly/93420 (Safari mp4)
- https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes (halfvec / 2000-dimension cap)
- https://soniox.com/compare-stt/soniox-vs-openai/urdu (vendor benchmark; low trust)
- https://vercel.com/ai-gateway/models/text-embedding-3-large (MIRACL figures; secondary)