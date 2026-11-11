# Gemini API (AI Studio key) research for Awaaz, checked against live docs on 2026-11-11

**Before you start:**
- **The docs have moved.** Every `ai.google.dev/gemini-api/docs/*` and `ai.google.dev/api/*` URL now returns a 301 redirect to `aistudio.google.com/docs/*` or `aistudio.google.com/api-reference/*`.
  - Many guide pages show the newer **Interactions API** by default.
  - Add `?generate-content=true` to a guide URL to see the `generateContent` version.
- **`generateContent` is legacy but still fully supported.** The migration guide says: "While `generateContent` remains fully supported, we recommend the Interactions API for all new development." It gives no end-of-support date. Source: https://aistudio.google.com/docs/migrate-to-interactions
  - The Interactions alternative is `POST https://generativelanguage.googleapis.com/v1beta/interactions` with headers `x-goog-api-key` and `Api-Revision: 2026-05-20`.
  - Its body is `{model, input, generation_config:{thinking_level}, response_format:{type:"text", mime_type:"application/json", schema}}`, and output text is in `steps[]` → `model_output` → `content[].text`.
- **I had no API key, so I made no live API calls.** Every shape below comes from the docs.

---

## 1. Models as of Nov 2026

Sources:
- https://aistudio.google.com/docs/models
- https://aistudio.google.com/docs/deprecations
- Per-model pages: https://aistudio.google.com/docs/models/{id}
- https://aistudio.google.com/docs/pricing

### Current text-output models

All of these take text, image, video, audio and PDF input, return text, have a 1,048,576-token input limit and a 65,536-token output limit, and support structured outputs, function calling and thinking.

| Model ID | Status | Released | Shutdown | Paid price per 1M tokens (in / out) | Free tier | Thinking levels (default) |
|---|---|---|---|---|---|---|
| `gemini-3.8-flash` | GA. Docs call it the "recommended default for everyday apps and agents" | Sep 2, 2026 | none | $0.75 / $3.75 until Dec 31, 2026, then **$1.50 / $7.50** from Jan 1, 2027. Same rate for all input types. | yes | low, **medium**, high. **`minimal` returns an error.** |
| `gemini-3.6-flash` | GA, "previous-generation" | Jul 21, 2026 | none | same as 3.8 Flash | yes | minimal, low, **medium**, high |
| `gemini-3.5-flash-lite` | GA. "fastest, most cost-effective 3.5 model" | Jul 21, 2026 | none | **$0.30 / $2.50** (input rate covers text, image, video and audio) | yes | **minimal**, low, medium, high |
| `gemini-3.1-flash-lite` | GA | May 7, 2026 | **May 7, 2027** → replaced by 3.5-flash-lite | $0.25 text / $0.50 audio / $1.50 out | yes | Level list in the generateContent thinking guide; the Interactions guide doesn't list it. |
| `gemini-2.5-flash-lite` | Not deprecated, served "until further notice" | Jul 22, 2025 | none | $0.10 text / $0.30 audio / $0.40 out | yes | Thinking off by default. Uses `thinkingBudget`, range 512–24576, `0` turns it off. |
| `gemini-4-argon` / `gemini-4-carbon` | Flagship reasoning models | Oct 13 / Nov 10, 2026 | none | $2/$10, rising to $4/$20 on Dec 1, 2026 | **no free tier** | low, medium, high. Thinking cannot be turned off. |

### Shut down, or auto-routed to another model, by Nov 2026

Do not use these IDs:
- `gemini-2.5-flash`: deprecated. API access is limited to existing users, and from **Dec 1, 2026** its requests are routed to `gemini-3.5-flash-lite`.
- `gemini-2.5-pro`: routed to `gemini-3.8-flash` from Dec 1, 2026.
- `gemini-3.5-flash` and `gemini-3.7-flash`: already auto-routed to 3.6-flash and 3.8-flash.
- Shut down:
  - `gemini-2.0-flash` and `gemini-2.0-flash-lite`, all variants: Jun 1, 2026.
  - `gemini-3-pro-preview`: Mar 9, 2026.
  - `gemini-3.1-flash-lite-preview`: May 25, 2026.
  - All `gemini-2.5-flash*-preview-*` models.
  - `text-embedding-004`: Jan 14, 2026.
  - `embedding-001`: Oct 30, 2025.
  - `gemini-embedding-2-preview`: **Nov 6, 2026**.
- `gemini-3-flash-preview` is still listed as a preview model; the listed replacement is 3.6-flash. Avoid it.
- TTS and Live preview models shut down Nov 17, 2026 (irrelevant here).

### `-latest` aliases

`gemini-flash-latest` and similar aliases exist. The version behind an alias is swapped with each release, with 2 weeks' email notice. **Pin explicit IDs instead.**

### Dedicated speech-to-text: `gemini-3.5-transcribe`

- Called with `POST .../v1beta/models/gemini-3.5-transcribe:generateContent` and `generationConfig.audioTranscriptionConfig:{languageCodes:[...], mode:"VERBATIM", diarization, wordTimestamp}`.
- Priced at $2 / 1M audio tokens in and $12 / 1M out.
- **Urdu (`ur-PK`) is not in its supported-language list** (Hindi `hi-IN` is). Do not rely on it for Urdu; use a general model with a prompt (section 2c).
- Its docs examples use the Files API (`fileData`) rather than inline data.
- Source: https://aistudio.google.com/docs/transcribe?generate-content=true

### Region and language

- Pakistan is on the list of regions where the Gemini API and AI Studio are available. Source: https://aistudio.google.com/docs/available-regions
- **Not verified:** the docs have no general language list for the API, so I could not confirm Urdu quality or official support for the text models.

---

## 2. REST shape for `generateContent`

- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- **Streaming:** `POST .../{model}:streamGenerateContent?alt=sse`, same body.
- **Headers:** `x-goog-api-key: <KEY>` and `Content-Type: application/json`.
- Sources: https://aistudio.google.com/docs/text-generation?generate-content=true and https://aistudio.google.com/api-reference/generate-content

### Request fields

From the API reference:
- `contents[]: {role: "user"|"model", parts[]}`.
- Each part has one of: `text`, `inlineData:{mimeType, data(base64)}`, `fileData:{mimeType, fileUri}`, `functionCall`, `functionResponse`, …
- Parts can also carry `thought` (bool) and `thoughtSignature`.
- `systemInstruction:{parts:[{text}]}`. The REST examples write it as `system_instruction`.
- `generationConfig` contains:
  - `responseMimeType`: `text/plain` (default), `application/json` or `text/x.enum`
  - `responseJsonSchema` (object)
  - `responseFormat:{text:{mimeType:"APPLICATION_JSON"|"TEXT_PLAIN", schema}}`
  - `thinkingConfig:{thinkingLevel, thinkingBudget, includeThoughts}`
  - `maxOutputTokens`, `stopSequences`, `seed`
  - `mediaResolution`: `MEDIA_RESOLUTION_LOW` (64 tokens), `_MEDIUM` (256) or `_HIGH`
  - `responseModalities`

**Casing:**
- The REST guide examples use snake_case: `inline_data`, `mime_type`, `system_instruction`.
- The API reference and SDKs use camelCase.
- Both forms appear in the official docs, so both are expected to work. I did not live-test this.

### Structured JSON: two documented forms

1. `generationConfig.responseMimeType: "application/json"` + `generationConfig.responseJsonSchema: {...}`
   - These are the field names the official JS/Go/Python SDKs use.
   - `responseMimeType` is defined in the API reference.
   - Older search-indexed docs show exactly this form in REST curl for Gemini 3.
2. `generationConfig.responseFormat.text: {mimeType: "APPLICATION_JSON", schema: {...}}`
   - This is the form the **current** REST curl example uses, with `gemini-3.8-flash`.
   - Source: https://aistudio.google.com/docs/structured-output?generate-content=true

**Not verified:**
- Whether `responseFormat` works on 2.5 models.
- Whether either form wins when both are sent. Send only one.
- The current page no longer mentions the old OpenAPI-subset `responseSchema`; use `responseJsonSchema`.

**Supported schema keywords:**
- types `string`, `number`, `integer`, `boolean`, `object`, `array`, `null` (nullable as `type: ["string","null"]`)
- `title`, `description`, `properties`, `required`, `additionalProperties`, `enum`, `format`, `minimum`, `maximum`, `items`, `prefixItems`, `minItems`, `maxItems`, `$defs`, `$ref`
- **Silently removed, not enforced:** `minLength`, `maxLength`, `min/maxProperties`, `uniqueItems`, `contains`. Validate these with Zod.
- An oversized or deeply nested schema returns `400 INVALID_ARGUMENT`.
- Output keys follow the order of keys in the schema.

### Thinking control

Sources: https://aistudio.google.com/docs/thinking?generate-content=true and https://aistudio.google.com/docs/text-generation?generate-content=true

- **Gemini 3.x / 4:** `"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}`.
  - The REST docs use lowercase. The API enum is `MINIMAL|LOW|MEDIUM|HIGH`.
  - A forum report found production REST accepts lowercase while AI Studio's validator wanted uppercase: https://discuss.ai.google.dev/t/bug-report-discrepancy-in-thinkinglevel-parameter-case-sensitivity-google-ai-studio-vs-production-api/113466
- **`thinkingBudget`:**
  - Deprecated on Gemini 4; the Gemini 3 docs say to use `thinkingLevel` instead.
  - **Sending `thinkingBudget` and `thinkingLevel` together returns a 400** (stated for Gemini 4).
  - Per the API reference, `thinkingLevel` on pre-Gemini-3 models returns an error. For 2.5 models, use `thinkingBudget` (`0` turns thinking off on 2.5-flash-lite).
- **`includeThoughts: true`** returns thought summaries as parts with `thought: true`.
- **Thought tokens are billed at the output rate and count against `maxOutputTokens`.** A low cap gives `finishReason: "MAX_TOKENS"` and truncated JSON.
- Gemini 3 and 4 may attach `thoughtSignature` to any part. Echo these back only in multi-turn or function-calling flows.

### Gotchas for 3.6+ and Gemini 4

Sources: https://aistudio.google.com/docs/text-generation?generate-content=true and https://aistudio.google.com/docs/whats-new-gemini-3.6?generate-content=true

- `temperature`, `topP` and `topK` are **ignored** and trigger deprecation warning headers; docs say they will return 400 in a future release. **Remove them.**
- `candidateCount` is unsupported on Gemini 3 and later.
- If the last non-empty turn is a `model` turn (a prefill), the API returns **400**. Use a system instruction or a schema instead.

### Response shape (API reference)

```json
{
  "candidates": [{
    "content": {"role": "model", "parts": [{"text": "...", "thoughtSignature": "..."}]},
    "finishReason": "STOP",
    "safetyRatings": [], "index": 0
  }],
  "promptFeedback": {"blockReason": "..."},
  "usageMetadata": {"promptTokenCount": 0, "candidatesTokenCount": 0, "thoughtsTokenCount": 0, "totalTokenCount": 0, "promptTokensDetails": []},
  "modelVersion": "gemini-3.5-flash-lite", "responseId": "..."
}
```

- `finishReason` values include `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER` and `MALFORMED_FUNCTION_CALL`.
- If the prompt is blocked, `candidates` may be empty and `promptFeedback.blockReason` is set.
- **To read the output:** concatenate `candidates[0].content.parts[].text`, skipping parts where `thought === true`.
- `modelVersion` is useful for spotting auto-routing.

### Inline media

- **Audio MIME types:** `audio/wav`, `audio/mp3`, `audio/aiff`, `audio/aac`, `audio/ogg`, `audio/flac`, `audio/mpeg`, `audio/m4a`, `audio/l16`, `audio/opus`, `audio/alaw`, `audio/mulaw`, **`audio/webm`**.
  - 32 tokens per second (1,920 per minute).
  - Downsampled to 16 Kbps mono.
  - Up to 9.5 hours of audio per prompt.
  - Source: https://aistudio.google.com/docs/audio?generate-content=true
- **Image MIME types:** `image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif`.
  - 258 tokens if both sides are ≤384px; larger images are tiled at 768×768, 258 tokens per tile.
  - Put the image part **before** the text part.
  - Source: https://aistudio.google.com/docs/image-understanding?generate-content=true
- **Total request limit is 20 MB**, including prompt, system instruction and inline bytes. Base64 adds about 33%, so the raw media cap is about 15 MB. Larger files need the Files API.

**My recommendations, not verified in the docs:**
- Strip codec parameters, e.g. send `audio/webm;codecs=opus` as `audio/webm`.
- Safari's MediaRecorder produces `audio/mp4`, which is not on the list. Try `audio/m4a`, or record as webm or ogg where possible.

### Minimal Deno helper (no SDK)

```ts
const KEY = Deno.env.get("GEMINI_API_KEY")!;
const BASE = "https://generativelanguage.googleapis.com/v1beta";

function b64(bytes: Uint8Array): string { // chunked to avoid call-stack limits
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function gemini(model: string, body: unknown) {
  const r = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${await r.text()}`); // 429 = RESOURCE_EXHAUSTED -> backoff
  const j = await r.json();
  const c = j.candidates?.[0];
  if (!c) throw new Error(`blocked: ${j.promptFeedback?.blockReason ?? "no candidates"}`);
  const text = (c.content?.parts ?? []).filter((p: any) => !p.thought && typeof p.text === "string").map((p: any) => p.text).join("");
  return { text, finishReason: c.finishReason, usage: j.usageMetadata, modelVersion: j.modelVersion };
}
```

**(a) Bilingual digest**

```ts
const { text } = await gemini("gemini-3.5-flash-lite", {
  systemInstruction: { parts: [{ text: "Summarize civic map pins. Output Urdu (Nastaliq script) first, then English. Max 80 words each." }] },
  contents: [{ role: "user", parts: [{ text: JSON.stringify(pins) }] }],
  generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 1024 },
});
```

**(b) Structured extraction**

```ts
const res = await gemini("gemini-3.5-flash-lite", {
  contents: [{ role: "user", parts: [{ text: `Extract the report fields:\n${userText}` }] }],
  generationConfig: {
    responseMimeType: "application/json",
    responseJsonSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["pothole", "garbage", "water", "electricity", "other"] },
        severity: { type: "integer", minimum: 1, maximum: 5 },
        location_text: { type: ["string", "null"] },
        summary_en: { type: "string" }, summary_ur: { type: "string" },
      },
      required: ["category", "severity", "summary_en", "summary_ur"],
    },
    thinkingConfig: { thinkingLevel: "minimal" }, // 3.5-flash-lite only; on 3.8-flash use "low"
  },
});
const data = JSON.parse(res.text); // then validate with Zod
// Documented alternative: generationConfig.responseFormat = { text: { mimeType: "APPLICATION_JSON", schema } }
```

**(c) Audio transcription with inline data**

```ts
const audio = new Uint8Array(await blob.arrayBuffer());
const { text } = await gemini("gemini-3.5-flash-lite", {
  contents: [{ role: "user", parts: [
    { inlineData: { mimeType: "audio/webm", data: b64(audio) } },
    { text: "Transcribe verbatim. Speech may be Urdu, English, or mixed; keep Urdu in Urdu script. Return only the transcript." },
  ]}],
  generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
});
```

**(d) Image understanding**

Same pattern as (c), with `{ inlineData: { mimeType: "image/jpeg", data } }` placed before the text part. Add `generationConfig.mediaResolution: "MEDIA_RESOLUTION_LOW"` for cheap, fast classification.

---

## 3. Embeddings

Sources:
- https://aistudio.google.com/docs/embeddings
- https://aistudio.google.com/docs/models/gemini-embedding-2
- https://aistudio.google.com/api-reference/embeddings

| | `gemini-embedding-2` (stable, Apr 2026) | `gemini-embedding-001` (shutdown May 14, 2028) |
|---|---|---|
| Inputs | text, image, video, audio, PDF | text only |
| Input token limit | 8,192 | 2,048 |
| Dimensions | 128–3072, default 3072. Docs recommend 768, **1536** or 3072. | same range |
| Normalization at truncated sizes | automatic | **manual** for any size other than 3072 (L2-normalize yourself) |
| Task hint | **no `taskType`.** Prefix the text instead, e.g. query `task: search result \| query: {text}`, document `title: {title or "none"} \| text: {text}`, or `task: classification \| query: …`, `task: clustering \| query: …`, `task: sentence similarity \| query: …` | `taskType`: `RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, `SEMANTIC_SIMILARITY`, `CLASSIFICATION`, `CLUSTERING`, `QUESTION_ANSWERING`, `FACT_VERIFICATION`, `CODE_RETRIEVAL_QUERY` |
| Price per 1M tokens | $0.20 text ($0.45 image, $6.50 audio) | $0.15 |

**1536 dimensions is supported and recommended for both models.**

**Endpoints:**
- `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent`
- Also `:batchEmbedContents` and `:asyncBatchEmbedContent`.

**Request body:**
- gemini-embedding-2: `{"content":{"parts":[{"text":"..."}]},"output_dimensionality":1536}`. The key is top-level in the docs' REST example; camelCase `outputDimensionality` is the SDK spelling.
- gemini-embedding-001: `{"taskType":"RETRIEVAL_DOCUMENT","outputDimensionality":1536,"content":{"parts":[{"text":"..."}]}}`.
- The API reference also shows a nested `embedContentConfig:{taskType, title, outputDimensionality, autoTruncate}`. The guide uses top-level keys, so **use top-level keys**. I could not verify the nested form.
- Several parts inside **one** `content` are aggregated into **one** embedding. To embed items separately, send separate requests or use batch.

**Response:**
- `embedContent` returns `{"embedding":{"values":[...]}, "usageMetadata":{"promptTokenCount":N}}`.
- **Not verified:** the synchronous `batchEmbedContents` request and response shape. The SDK exposes `embeddings[].values`, and the batch body seen in the docs is `{"requests":[{"model":"models/gemini-embedding-2","content":{...}}]}`.

```ts
async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${BASE}/models/gemini-embedding-2:embedContent`, {
    method: "POST", headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] }, output_dimensionality: 1536 }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
  return (await r.json()).embedding.values;
}
```

**Embedding spaces are not interchangeable:**
- Vectors from gemini-embedding-2, gemini-embedding-001, OpenAI `text-embedding-3-*` and so on cannot be compared with each other. The Gemini docs say 001 and 2 "are **incompatible**".
- Never use one model as a fallback that writes into a pgvector column filled by another model.
- Either choose one embedding model for the whole column, or keep a separate column per model and query only the matching one.

---

## 4. Rate limits and tiers

Source: https://aistudio.google.com/docs/rate-limits

- **Exact per-model RPM, TPM and RPD are no longer published.** The docs say "View your active rate limits in AI Studio" and that limits "are not guaranteed". Third-party figures (roughly 15 RPM / 1,000 RPD for Flash-Lite on the free tier) are old and inconsistent. **Not verified.**

| Tier | How to qualify | Billing cap |
|---|---|---|
| Free | an active project | none |
| Tier 1 | link a billing account | $250 |
| Tier 2 | $100 spent and 3 days since first payment | $2,000 |
| Tier 3 | $1,000 spent and 30 days | $20k–$100k+ |

- Tier 1 has a $10 spend limit per rolling 10 minutes.
- Google Search grounding defaults to 1,500 RPD per project on Gemini 3+.
- **Free tier: content is used to improve Google products** (stated per model on the pricing page). For real citizen reports, use a billed key so that data stays out of training.
- Free-tier access covers 3.8-flash, 3.6-flash, 3.5-flash-lite, 3.1-flash-lite, 2.5-flash-lite, 3.5-transcribe and both embedding models. **Gemini 4 has no free tier.**

---

## 5. Recommended Gemini config

```ts
export const GEMINI = {
  base: "https://generativelanguage.googleapis.com/v1beta",
  digest:        { model: "gemini-3.5-flash-lite", thinkingLevel: "low" },      // upgrade: gemini-3.8-flash + "low"
  extractJson:   { model: "gemini-3.5-flash-lite", thinkingLevel: "minimal" },  // responseMimeType + responseJsonSchema
  transcribe:    { model: "gemini-3.5-flash-lite", thinkingLevel: "minimal" },  // inline audio <= ~15MB raw; harder audio: gemini-3.8-flash "low"
  vision:        { model: "gemini-3.5-flash-lite", thinkingLevel: "minimal" },  // mediaResolution LOW for classification
  qualityFallback: { model: "gemini-3.8-flash", thinkingLevel: "low" },         // never "minimal" here: it errors
  cheapestLegacy:  { model: "gemini-2.5-flash-lite", thinkingBudget: 0 },       // use thinkingBudget, not thinkingLevel
  embed:         { model: "gemini-embedding-2", output_dimensionality: 1536 },  // or gemini-embedding-001 + taskType + manual L2-normalize
};
```

**Why:**
- **`gemini-3.5-flash-lite` as the default for all four tasks:**
  - It is the newest GA Flash-Lite model, with no shutdown date.
  - It accepts every input Awaaz needs (audio including webm and ogg, images, PDF) and supports structured outputs.
  - Its default thinking level is `minimal`, so it is fast.
  - At $0.30 / $2.50 it is the cheapest current-generation model.
  - The docs explicitly recommend keeping `minimal` for high-volume extraction and classification.
  - Raise it to `low` for the digest so the Urdu writing is more careful.
- **`gemini-3.8-flash` as the quality fallback:**
  - It is newer than `gemini-3.6-flash` at the same price, so 3.6 Flash has no advantage.
  - Its price doubles on **Jan 1, 2027**.
  - **It rejects `thinkingLevel: "minimal"`**, and its default is `medium`, which is slow. Always set `"low"`.
- **Do not use `gemini-2.5-flash`:** it is deprecated, limited to existing users, and silently routed from Dec 1, 2026. `gemini-2.5-flash-lite` is still served and cheapest ($0.10 / $0.40) but is an older generation.
- **Do not use `gemini-3.5-transcribe` for Urdu:** `ur-PK` is not on its language list. Transcribe with a general Flash model and a prompt.
- **Embeddings:** `gemini-embedding-2` at 1536 dimensions is stable, normalized automatically, takes multimodal input and allows 8K tokens. It fits a `vector(1536)` column. pgvector's HNSW index handles up to 2,000 dims; that limit is from my memory of pgvector, not checked here.

## Not verified

- No live API calls were made, because no key was available.
- Whether the two structured-JSON forms are interchangeable on every model.
- That snake_case and camelCase keys are both accepted (both appear in official docs).
- The synchronous `batchEmbedContents` response shape.
- The `embedContentConfig` nesting versus top-level keys.
- Exact free-tier RPM / RPD numbers.
- Urdu quality and official language support in the text models.
- Whether a codec parameter in the audio MIME type is accepted, and whether Safari's `audio/mp4` works.
- Whether `thinkingLevel` and `thinkingBudget` together also returns 400 on Gemini 3 (documented only for Gemini 4).
