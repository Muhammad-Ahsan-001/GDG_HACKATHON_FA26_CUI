// Generate the pre-recorded voice-guide clips (Urdu + English) with OpenAI TTS.
//   node scripts/gen-voice-prompts.mjs           only new/changed prompts
//   node scripts/gen-voice-prompts.mjs --force   regenerate everything
// Source text: src/lib/voice/prompts.json  ->  public/voice/<lang>/<id>.mp3 (+ public/voice/manifest.json hashes)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(ROOT, 'supabase/functions/.env')
const KEY = (readFileSync(envFile, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m) || [])[1]?.trim()
if (!KEY) { console.error('OPENAI_API_KEY missing in supabase/functions/.env'); process.exit(1) }

const MODEL = 'gpt-4o-mini-tts'   // keep in sync with supabase/functions/_shared/models.ts (MODELS.tts.primary)
const VOICES = { ur: 'marin', en: 'cedar' }
const INSTRUCTIONS = {
  ur: 'Speak in warm, natural Pakistani Urdu, slowly and very clearly, like a kind helper explaining to an elderly person who cannot read. Pause briefly between sentences.',
  en: 'Speak in warm, clear, friendly English with a gentle South Asian accent, slowly, like a kind helper explaining to someone new to smartphones.',
}
const prompts = JSON.parse(readFileSync(join(ROOT, 'src/lib/voice/prompts.json'), 'utf8'))
const outDir = join(ROOT, 'public/voice')
const manifestPath = join(outDir, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
const force = process.argv.includes('--force')

let made = 0
for (const [id, texts] of Object.entries(prompts)) {
  for (const lang of ['ur', 'en']) {
    const text = texts[lang]
    const hash = createHash('sha256').update(`${MODEL}|${VOICES[lang]}|${INSTRUCTIONS[lang]}|${text}`).digest('hex').slice(0, 16)
    const file = join(outDir, lang, `${id}.mp3`)
    if (!force && existsSync(file) && manifest[`${lang}/${id}`] === hash) continue
    mkdirSync(dirname(file), { recursive: true })
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, voice: VOICES[lang], input: text, instructions: INSTRUCTIONS[lang], response_format: 'mp3', speed: lang === 'ur' ? 0.95 : 1 }),
    })
    if (!r.ok) { console.error(`${lang}/${id}: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exitCode = 1; continue }
    writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    manifest[`${lang}/${id}`] = hash
    made++
    console.log(`ok ${lang}/${id}`)
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`done: ${made} clip(s) generated`)
