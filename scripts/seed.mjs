#!/usr/bin/env node
// Awaaz demo seed (idempotent — safe to re-run; re-running also resets seeded pins/assignments to their demo state).
//
//   node scripts/seed.mjs           users + organisations + clusters/reports/assignments/votes/notifications
//   node scripts/seed.mjs --embed   only backfill embeddings of seeded reports that have none
//
// Reads SUPABASE_URL + SUPABASE_KEY_SERVICE_ROLE from .secrets/supabase.env (env vars override) and
// OPENAI_API_KEY from supabase/functions/.env (if empty, embeddings stay null and a note is printed).
// Everything seeded uses stable ids derived from a key, so nothing outside the seed set is touched.
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EMBED_ONLY = process.argv.includes('--embed')

// ------------------------------------------------------------------ config
function readEnvFile(rel) {
  const file = path.join(ROOT, rel)
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const secrets = readEnvFile('.secrets/supabase.env')
const fnEnv = readEnvFile('supabase/functions/.env')
const SUPABASE_URL = process.env.SUPABASE_URL || secrets.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || secrets.SUPABASE_KEY_SERVICE_ROLE
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || fnEnv.OPENAI_API_KEY || '').trim()
const EMBED_MODEL = 'text-embedding-3-large' // must match supabase/functions/_shared/models.ts MODELS.embed.primary
const EMBED_DIMS = 1536

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY_SERVICE_ROLE (.secrets/supabase.env)')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

// demo accounts + password come from the frontend's single source of truth
const demoSrc = readFileSync(path.join(ROOT, 'src/lib/demoAccounts.ts'), 'utf8')
const DEMO_PASSWORD = demoSrc.match(/DEMO_PASSWORD\s*=\s*'([^']+)'/)?.[1]
if (!DEMO_PASSWORD) throw new Error('DEMO_PASSWORD not found in src/lib/demoAccounts.ts')
const DEMO_ACCOUNTS = [...demoSrc.matchAll(/email:\s*'([^']+)',\s*role:\s*'([^']+)',\s*label_en:\s*'([^']+)'/g)]
  .map((m) => ({ email: m[1], role: m[2], label_en: m[3] }))

// ------------------------------------------------------------------ helpers
/** Stable UUID (v5-style, sha1) from a seed key. */
function sid(key) {
  const h = createHash('sha1').update(`awaaz-seed:${key}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}
const ewkt = (lat, lng) => `SRID=4326;POINT(${lng} ${lat})`
const iso = (ms) => new Date(ms).toISOString()
const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371008.8
  const r = Math.PI / 180
  const dLat = (bLat - aLat) * r
  const dLng = (bLng - aLng) * r
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
/** shift a point by metres north / east */
function offset(lat, lng, north = 0, east = 0) {
  return [lat + north / 111320, lng + east / (111320 * Math.cos((lat * Math.PI) / 180))]
}

function must(res, label) {
  if (res.error) throw new Error(`${label}: ${res.error.message}${res.error.details ? ` (${res.error.details})` : ''}`)
  return res.data
}

async function embedTexts(texts) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
  })
  if (!r.ok) throw new Error(`OpenAI embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const j = await r.json()
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

/** Embed the given report rows ({id, canonical_en}) in batches and store vector + model. */
async function storeEmbeddings(rows) {
  let done = 0
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50)
    const vectors = await embedTexts(batch.map((r) => r.canonical_en))
    for (let k = 0; k < batch.length; k++) {
      must(await db.from('reports')
        .update({ embedding: JSON.stringify(vectors[k]), embedding_model: EMBED_MODEL })
        .eq('id', batch[k].id), `embed ${batch[k].id}`)
      done++
    }
  }
  return done
}

// demo zones that must stay EMPTY (live demo reports are made there)
const DEMO_ZONES = [
  { name: 'G-9/4 Street 5 school', lat: 33.6888, lng: 73.0262 },
  { name: 'G-9 Markaz wedding hall', lat: 33.6905, lng: 73.0335 },
]
const DEMO_ZONE_CLEARANCE_M = 700

// ------------------------------------------------------------------ people
const PEOPLE = {
  'citizen1@awaaz.demo': { name: 'Ayesha', language: 'ur', trust: 0.6 },
  'citizen2@awaaz.demo': { name: 'Bilal', language: 'ur', trust: 0.6 },
  'citizen3@awaaz.demo': { name: 'Hina', language: 'ur', trust: 0.8 },
  'citizen4@awaaz.demo': { name: 'Usman', language: 'en', trust: 0.7 },
  'citizen5@awaaz.demo': { name: 'Zainab', language: 'ur', trust: 0.5 },
}
const ACCOUNTS = [
  ...DEMO_ACCOUNTS,
  { email: 'citizen3@awaaz.demo', role: 'citizen', label_en: 'Citizen (Hina)' },
  { email: 'citizen4@awaaz.demo', role: 'citizen', label_en: 'Citizen (Usman)' },
  { email: 'citizen5@awaaz.demo', role: 'citizen', label_en: 'Citizen (Zainab)' },
].map((a) => ({
  ...a,
  display_name: PEOPLE[a.email]?.name ?? a.label_en,
  language: PEOPLE[a.email]?.language ?? 'en',
  trust: PEOPLE[a.email]?.trust ?? 0.8,
}))

// short aliases used in the data below
const U = {
  c1: 'citizen1@awaaz.demo', c2: 'citizen2@awaaz.demo', c3: 'citizen3@awaaz.demo',
  c4: 'citizen4@awaaz.demo', c5: 'citizen5@awaaz.demo',
}

// ------------------------------------------------------------------ organisations
const ORGS = [
  { key: 'rescue1122', owner: 'rescue1122@awaaz.demo', name: 'Rescue 1122 Islamabad (Demo)', org_type: 'rescue_1122',
    categories: ['hazard', 'fire', 'flood', 'health'], lat: 33.6600, lng: 73.0600, radius_m: 25000 },
  { key: 'fire', owner: 'fire@awaaz.demo', name: 'Fire Brigade Islamabad (Demo)', org_type: 'fire',
    categories: ['fire'], lat: 33.6900, lng: 73.0500, radius_m: 20000 },
  { key: 'police', owner: 'police@awaaz.demo', name: 'Police Helpline (Demo)', org_type: 'police',
    categories: ['safety'], lat: 33.6700, lng: 73.0600, radius_m: 25000 },
  { key: 'water', owner: 'water@awaaz.demo', name: 'Water & Sanitation Authority (Demo)', org_type: 'water',
    categories: ['water', 'flood'], lat: 33.6500, lng: 73.0600, radius_m: 25000 },
  { key: 'shelter', owner: 'shelter@awaaz.demo', name: 'Saya Shelter Home (Demo)', org_type: 'shelter',
    categories: ['food', 'flood'], lat: 33.6880, lng: 73.0300, radius_m: 8000 },
  { key: 'foodbank', owner: 'foodbank@awaaz.demo', name: 'Rizq Food Bank (Demo)', org_type: 'food_bank',
    categories: ['food'], lat: 33.6680, lng: 73.0760, radius_m: 10000 },
  { key: 'health', owner: 'health@awaaz.demo', name: 'Sehat Sathi Health NGO (Demo)', org_type: 'health_ngo',
    categories: ['health'], lat: 33.6000, lng: 73.0500, radius_m: 10000 },
]
const ORG_BY_KEY = Object.fromEntries(ORGS.map((o) => [o.key, o]))

// ------------------------------------------------------------------ incidents
// hoursAgo = first report; report.min = minutes after the first report; report.at = [metres north, metres east]
// assignment times are minutes after the first report.
const CLUSTERS = [
  {
    key: 'live_wire', category: 'hazard', urgency: 'critical', status: 'verified', confidence: 0.91,
    area: 'Jinnah Super Market, F-7, Islamabad', hints: ['Jinnah Super', 'F-7', 'Islamabad'],
    lat: 33.7210, lng: 73.0560, hoursAgo: 20, notified: true,
    title_en: 'Live electric wire fallen on road',
    title_ur: 'سڑک پر بجلی کی ننگی تار گری ہوئی ہے',
    summary_en: 'A live electricity wire has fallen across the service road near Jinnah Super Market, F-7. It is sparking and people are walking past it.',
    summary_ur: 'ایف سیون جناح سپر مارکیٹ کے قریب سروس روڈ پر بجلی کی ننگی تار گری ہوئی ہے۔ اس سے چنگاریاں نکل رہی ہیں اور لوگ پاس سے گزر رہے ہیں۔',
    ai_reason: '3 independent reporters (voice and text) within 60 m in 40 minutes; 2 neighbours confirmed it.',
    reports: [
      { by: U.c3, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'جناح سپر کے پاس بجلی کی تار سڑک پر گری ہوئی ہے، چنگاریاں نکل رہی ہیں، جلدی کسی کو بھیجیں',
        canonical_en: 'fallen live electric wire sparking on road near jinnah super market, f-7 islamabad' },
      { by: U.c4, modes: ['text'], language: 'en', min: 14, at: [25, -30],
        transcript: 'Live wire down on the road behind Jinnah Super, F-7. Very dangerous, kids around.',
        canonical_en: 'live electric wire down on road behind jinnah super market, f-7 islamabad' },
      { by: U.c5, modes: ['voice'], language: 'ur', min: 38, at: [-35, 20],
        transcript: 'ایف سیون میں تار گری ہوئی ہے، کرنٹ ہے، بچے پاس کھیل رہے ہیں',
        canonical_en: 'electric wire fallen with current near jinnah super, f-7 islamabad' },
    ],
    votes: [[U.c1, 'confirm'], [U.c2, 'confirm']],
    assignments: [{ org: 'rescue1122', status: 'alerted', alerted: 40 }],
  },
  {
    key: 'water_main', category: 'water', urgency: 'high', status: 'verified', confidence: 0.86,
    area: 'Jinnah Avenue, Blue Area, Islamabad', hints: ['Jinnah Avenue', 'Blue Area', 'Islamabad'],
    lat: 33.7090, lng: 73.0570, hoursAgo: 30,
    title_en: 'Burst water main flooding Blue Area road',
    title_ur: 'بلیو ایریا میں پانی کی مین لائن پھٹ گئی',
    summary_en: 'A large water main has burst on the Jinnah Avenue service lane in Blue Area; clean water has been gushing onto the road for hours.',
    summary_ur: 'بلیو ایریا میں جناح ایونیو کی سروس لین پر پانی کی بڑی لائن پھٹ گئی ہے اور گھنٹوں سے صاف پانی سڑک پر بہہ رہا ہے۔',
    ai_reason: '2 independent reporters with matching descriptions 40 m apart; confirmed by a neighbour.',
    reports: [
      { by: U.c3, modes: ['text'], language: 'en', min: 0, at: [0, 0],
        transcript: 'Water pipe burst near Blue Area service road, water flowing on the road since morning.',
        canonical_en: 'burst water main pipe flooding service road, blue area islamabad' },
      { by: U.c4, modes: ['voice'], language: 'ur', min: 22, at: [30, 25],
        transcript: 'بلیو ایریا میں پانی کا پائپ پھٹا ہوا ہے، سارا پانی ضائع ہو رہا ہے',
        canonical_en: 'water pipe burst wasting water on road, blue area islamabad' },
    ],
    votes: [[U.c5, 'confirm']],
    assignments: [{ org: 'water', status: 'claimed', alerted: 24, claimed: 50 }],
  },
  {
    key: 'garbage_fire', category: 'fire', urgency: 'high', status: 'in_progress', confidence: 0.88,
    area: 'Sabzi Mandi Road, I-10, Islamabad', hints: ['Sabzi Mandi', 'I-10', 'Islamabad'],
    lat: 33.6470, lng: 73.0390, hoursAgo: 9,
    title_en: 'Garbage dump on fire, thick smoke',
    title_ur: 'کچرے کے ڈھیر میں آگ، گہرا دھواں',
    summary_en: 'A large garbage heap is burning near the I-10 Sabzi Mandi road; thick smoke is spreading into nearby homes.',
    summary_ur: 'آئی ٹین سبزی منڈی روڈ کے قریب کچرے کے بڑے ڈھیر میں آگ لگی ہے اور گہرا دھواں قریبی گھروں تک پھیل رہا ہے۔',
    ai_reason: '2 independent reporters (voice and text) within 50 m; Fire Brigade is on site.',
    reports: [
      { by: U.c4, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'آئی ٹین سبزی منڈی کے پاس کچرے میں آگ لگی ہے، بہت دھواں ہے، سانس لینا مشکل ہے',
        canonical_en: 'garbage dump fire with thick smoke near sabzi mandi road, i-10 islamabad' },
      { by: U.c5, modes: ['text'], language: 'en', min: 9, at: [-30, 35],
        transcript: 'Big garbage fire near I-10 sabzi mandi, smoke going into houses.',
        canonical_en: 'garbage heap burning near sabzi mandi, i-10 islamabad' },
    ],
    assignments: [
      { org: 'fire', status: 'in_progress', alerted: 10, claimed: 16, in_progress: 25 },
      { org: 'rescue1122', status: 'alerted', alerted: 10 },
    ],
  },
  {
    key: 'street_flooding', category: 'flood', urgency: 'medium', status: 'unconfirmed', confidence: 0.42,
    area: 'Street 12, G-11/2, Islamabad', hints: ['G-11/2', 'Islamabad'],
    lat: 33.6680, lng: 72.9970, hoursAgo: 14,
    title_en: 'Street flooded after rain in G-11',
    title_ur: 'بارش کے بعد جی الیون کی گلی میں پانی',
    summary_en: 'Rainwater has collected knee-deep in a G-11/2 street; cars and motorbikes are getting stuck.',
    summary_ur: 'جی الیون ٹو کی ایک گلی میں بارش کا پانی گھٹنوں تک جمع ہے، گاڑیاں اور موٹر سائیکلیں پھنس رہی ہیں۔',
    ai_reason: 'Single report without a photo; waiting for a second reporter or neighbour confirmation.',
    reports: [
      { by: U.c5, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'جی الیون ٹو کی گلی میں بارش کا پانی گھٹنوں تک ہے، گاڑیاں پھنس رہی ہیں',
        canonical_en: 'knee-deep rainwater flooding street, g-11/2 islamabad' },
    ],
  },
  {
    key: 'nullah_lai', category: 'flood', urgency: 'high', status: 'verified', confidence: 0.89,
    area: 'Gawalmandi Bridge, Nullah Lai, Rawalpindi', hints: ['Gawalmandi', 'Nullah Lai', 'Rawalpindi'],
    lat: 33.6060, lng: 73.0580, hoursAgo: 7, notified: true,
    title_en: 'Nullah Lai water level rising fast',
    title_ur: 'نالہ لئی میں پانی تیزی سے بڑھ رہا ہے',
    summary_en: 'Water in Nullah Lai near Gawalmandi bridge is rising quickly and has nearly reached the banks; low-lying houses may flood.',
    summary_ur: 'گوالمنڈی پل کے قریب نالہ لئی میں پانی تیزی سے بڑھ رہا ہے اور کناروں تک پہنچ گیا ہے، نشیبی گھروں میں پانی آ سکتا ہے۔',
    ai_reason: '3 independent reporters (Urdu, Punjabi and English) within 80 m in 50 minutes; 2 confirmations.',
    reports: [
      { by: U.c3, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'گوالمنڈی پل کے پاس نالہ لئی کا پانی بہت تیزی سے اوپر آ رہا ہے، کنارے تک پہنچ گیا ہے',
        canonical_en: 'nullah lai water level rising fast near gawalmandi bridge, rawalpindi' },
      { by: U.c4, modes: ['text'], language: 'en', min: 18, at: [40, -30],
        transcript: 'Nullah Lai almost overflowing at Gawalmandi, houses near the bank at risk.',
        canonical_en: 'nullah lai almost overflowing at gawalmandi, rawalpindi' },
      { by: U.c1, modes: ['voice'], language: 'pa', min: 50, at: [-45, 35],
        transcript: 'نالہ لئی دا پانی بہت ودھ گیا اے، گھراں وچ آن والا اے',
        canonical_en: 'nullah lai water rising and about to enter houses, gawalmandi rawalpindi' },
    ],
    votes: [[U.c5, 'confirm'], [U.c2, 'confirm']],
    assignments: [
      { org: 'rescue1122', status: 'alerted', alerted: 19 },
      { org: 'water', status: 'alerted', alerted: 19 },
    ],
  },
  {
    key: 'harassment', category: 'safety', urgency: 'medium', status: 'unconfirmed', confidence: 0.45,
    area: 'Wagon stop, Raja Bazaar, Rawalpindi', hints: ['Raja Bazaar', 'wagon stop', 'Rawalpindi'],
    lat: 33.6190, lng: 73.0660, hoursAgo: 26,
    title_en: 'Women harassed near Raja Bazaar wagon stop',
    title_ur: 'راجہ بازار ویگن اسٹاپ پر خواتین کو ہراساں کیا جاتا ہے',
    summary_en: 'A group of men harasses women and girls at the Raja Bazaar wagon stop in the evenings.',
    summary_ur: 'شام کے وقت راجہ بازار ویگن اسٹاپ پر کچھ لوگ خواتین اور لڑکیوں کو تنگ کرتے ہیں۔',
    ai_reason: 'Single report; recurring-issue description, no second reporter yet.',
    reports: [
      { by: U.c4, modes: ['text'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'راجہ بازار ویگن اسٹاپ پر شام کو کچھ لڑکے خواتین کو تنگ کرتے ہیں، پولیس کو بتائیں',
        canonical_en: 'men harassing women in the evening at wagon stop, raja bazaar rawalpindi' },
    ],
  },
  {
    key: 'contaminated_tap', category: 'water', urgency: 'medium', status: 'verified', confidence: 0.78,
    area: 'Block B, Satellite Town, Rawalpindi', hints: ['Satellite Town', 'Block B', 'Rawalpindi'],
    lat: 33.6390, lng: 73.0700, hoursAgo: 40,
    title_en: 'Dirty, smelly tap water in Satellite Town',
    title_ur: 'سیٹلائٹ ٹاؤن میں نلکوں کا پانی گندا اور بدبودار',
    summary_en: 'Tap water in Satellite Town Block B is brown and smells of sewage; several families report stomach problems.',
    summary_ur: 'سیٹلائٹ ٹاؤن بلاک بی میں نلکوں سے بھورا اور بدبودار پانی آ رہا ہے، کئی گھروں میں لوگوں کے پیٹ خراب ہیں۔',
    ai_reason: '2 independent reporters in the same block plus 1 confirmation.',
    reports: [
      { by: U.c4, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'سیٹلائٹ ٹاؤن بلاک بی میں نلکے سے گندا پانی آ رہا ہے، گٹر جیسی بو ہے',
        canonical_en: 'brown sewage-smelling tap water, block b satellite town rawalpindi' },
      { by: U.c5, modes: ['text'], language: 'en', min: 95, at: [60, -40],
        transcript: 'Tap water is brown and smelly in Satellite Town B block, kids have stomach issues.',
        canonical_en: 'contaminated brown tap water causing stomach problems, satellite town block b rawalpindi' },
    ],
    votes: [[U.c3, 'confirm']],
    assignments: [{ org: 'water', status: 'alerted', alerted: 96 }],
  },
  {
    key: 'dengue', category: 'health', urgency: 'medium', status: 'verified', confidence: 0.8,
    area: 'Near Committee Chowk, Rawalpindi', hints: ['Committee Chowk', 'Rawalpindi'],
    lat: 33.6130, lng: 73.0640, hoursAgo: 34,
    title_en: 'Stagnant water breeding dengue mosquitoes',
    title_ur: 'کھڑے پانی میں ڈینگی مچھر پیدا ہو رہے ہیں',
    summary_en: 'An empty plot near Committee Chowk has stagnant water and many mosquitoes; two dengue cases were reported in the lane.',
    summary_ur: 'کمیٹی چوک کے قریب خالی پلاٹ میں پانی کھڑا ہے اور بہت مچھر ہیں، گلی میں ڈینگی کے دو کیس سامنے آئے ہیں۔',
    ai_reason: '2 independent reporters (text and voice) plus 1 confirmation.',
    reports: [
      { by: U.c3, modes: ['text'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'کمیٹی چوک کے پاس خالی پلاٹ میں پانی کھڑا ہے، مچھر بہت ہیں، دو لوگوں کو ڈینگی ہو گیا',
        canonical_en: 'stagnant water with dengue mosquitoes in empty plot near committee chowk, rawalpindi' },
      { by: U.c5, modes: ['voice'], language: 'ur', min: 70, at: [-30, 45],
        transcript: 'کمیٹی چوک والی گلی میں گندا پانی کھڑا ہے، ڈینگی پھیل رہا ہے',
        canonical_en: 'standing dirty water spreading dengue in lane near committee chowk, rawalpindi' },
    ],
    votes: [[U.c4, 'confirm']],
    assignments: [{ org: 'health', status: 'claimed', alerted: 71, claimed: 110 }],
  },
  {
    key: 'man_collapsed', category: 'health', urgency: 'high', status: 'resolved', confidence: 0.9,
    area: 'Saddar Market footpath, Rawalpindi', hints: ['Saddar', 'Rawalpindi'],
    lat: 33.5973, lng: 73.0528, hoursAgo: 3,
    title_en: 'Elderly man collapsed on Saddar footpath',
    title_ur: 'صدر میں فٹ پاتھ پر بزرگ آدمی بے ہوش',
    summary_en: 'An elderly man collapsed on the footpath outside Saddar market and is not responding; passers-by are asking for an ambulance.',
    summary_ur: 'صدر بازار کے باہر فٹ پاتھ پر ایک بزرگ آدمی گر کر بے ہوش ہو گئے ہیں، راہگیر ایمبولینس بلا رہے ہیں۔',
    ai_reason: '2 independent reporters within 3 minutes; Rescue 1122 responded and closed the case.',
    reports: [
      { by: U.c2, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'صدر بازار کے باہر ایک بابا جی گر گئے ہیں، ہوش میں نہیں ہیں، ایمبولینس بھیجیں',
        canonical_en: 'elderly man collapsed unconscious on footpath outside saddar market, rawalpindi' },
      { by: U.c3, modes: ['text'], language: 'en', min: 3, at: [15, 20],
        transcript: 'Old man fainted outside Saddar market, needs ambulance urgently.',
        canonical_en: 'old man fainted outside saddar market needs ambulance, rawalpindi' },
    ],
    assignments: [{ org: 'rescue1122', status: 'resolved', alerted: 4, claimed: 6, in_progress: 9, resolved: 45,
      note: 'Patient shifted to hospital.' }],
  },
  {
    key: 'traffic_signal', category: 'hazard', urgency: 'medium', status: 'unconfirmed', confidence: 0.5,
    area: 'Faizabad Interchange, Islamabad', hints: ['Faizabad', 'Islamabad'],
    lat: 33.6640, lng: 73.0840, hoursAgo: 18,
    title_en: 'Traffic signal not working at Faizabad',
    title_ur: 'فیض آباد پر ٹریفک سگنل خراب',
    summary_en: 'The traffic signal at Faizabad interchange has been off since morning, causing jams and near-accidents.',
    summary_ur: 'فیض آباد انٹرچینج کا ٹریفک سگنل صبح سے بند ہے جس سے رش لگا ہے اور حادثوں کا خطرہ ہے۔',
    ai_reason: 'Single text report with 1 confirmation; below the verification threshold.',
    reports: [
      { by: U.c5, modes: ['text'], language: 'en', min: 0, at: [0, 0],
        transcript: 'Faizabad signal is off since morning, huge jam and almost accidents.',
        canonical_en: 'traffic signal not working causing jams at faizabad interchange, islamabad' },
    ],
    votes: [[U.c3, 'confirm']],
  },
  {
    key: 'leftover_food', category: 'food', urgency: 'medium', status: 'verified', confidence: 0.84,
    area: 'I-8 Markaz, Islamabad', hints: ['I-8 Markaz', 'restaurant', 'Islamabad'],
    lat: 33.6680, lng: 73.0760, hoursAgo: 1,
    food: { servings: 60, type: 'rice and daal', safeHoursFromNow: 3 },
    title_en: '60 servings of fresh leftover food',
    title_ur: 'ساٹھ افراد کا تازہ بچا ہوا کھانا دستیاب',
    summary_en: 'A restaurant in I-8 Markaz has about 60 servings of fresh rice and daal left after an event; safe to eat for about 3 hours.',
    summary_ur: 'آئی ایٹ مرکز کے ایک ریسٹورنٹ میں تقریب کے بعد تقریباً ساٹھ افراد کے لیے تازہ چاول اور دال بچی ہے، تقریباً تین گھنٹے تک کھانے کے قابل ہے۔',
    ai_reason: 'Donor report with food details and 2 confirmations from nearby users.',
    reports: [
      { by: U.c3, modes: ['text'], language: 'en', min: 0, at: [0, 0],
        transcript: 'We have around 60 plates of rice and daal left after an event at our restaurant in I-8 Markaz. Please pick up within 3 hours.',
        canonical_en: 'leftover fresh food 60 servings rice and daal at restaurant, i-8 markaz islamabad' },
    ],
    votes: [[U.c4, 'confirm'], [U.c5, 'confirm']],
    assignments: [
      { org: 'foodbank', status: 'alerted', alerted: 2 },
      { org: 'shelter', status: 'alerted', alerted: 2 },
    ],
  },
  {
    key: 'open_drain', category: 'hazard', urgency: 'high', status: 'unconfirmed', confidence: 0.48,
    area: 'Street 22, F-6/3, Islamabad', hints: ['F-6/3', 'Islamabad'],
    lat: 33.7290, lng: 73.0750, hoursAgo: 22,
    title_en: 'Open manhole without cover in F-6',
    title_ur: 'ایف سکس کی گلی میں کھلا مین ہول',
    summary_en: 'A deep drain manhole in F-6/3 has no cover; it is hard to see at night and a child nearly fell in.',
    summary_ur: 'ایف سکس تھری میں ایک گہرے نالے کا ڈھکن غائب ہے، رات کو نظر نہیں آتا اور ایک بچہ گرتے گرتے بچا۔',
    ai_reason: 'Single report, high urgency: routed to Rescue 1122 while awaiting confirmation.',
    reports: [
      { by: U.c4, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'ایف سکس تھری کی گلی میں گٹر کا ڈھکن نہیں ہے، ایک بچہ گرنے لگا تھا',
        canonical_en: 'open manhole drain without cover in street, f-6/3 islamabad' },
    ],
    assignments: [{ org: 'rescue1122', status: 'alerted', alerted: 1 }],
  },
  {
    key: 'accident_debris', category: 'hazard', urgency: 'high', status: 'resolved', confidence: 0.87,
    area: 'Main Boulevard, Bahria Town Phase 4, Rawalpindi', hints: ['Bahria Town', 'Phase 4', 'Main Boulevard'],
    lat: 33.5300, lng: 73.1000, hoursAgo: 44,
    title_en: 'Accident debris blocking Bahria Town road',
    title_ur: 'بحریہ ٹاؤن کی سڑک پر حادثے کا ملبہ',
    summary_en: 'Glass and metal debris from a car accident is blocking one lane of the main boulevard in Bahria Town Phase 4.',
    summary_ur: 'بحریہ ٹاؤن فیز فور کے مین بلیوارڈ پر گاڑی کے حادثے کا شیشہ اور ملبہ ایک لین بند کیے ہوئے ہے۔',
    ai_reason: '2 independent reporters within 70 m; cleared by Rescue 1122.',
    reports: [
      { by: U.c5, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'بحریہ ٹاؤن فیز فور مین روڈ پر ایکسیڈنٹ ہوا ہے، شیشے اور لوہا سڑک پر پڑا ہے',
        canonical_en: 'car accident glass and metal debris blocking lane on main boulevard, bahria town phase 4' },
      { by: U.c3, modes: ['text'], language: 'en', min: 11, at: [50, 45],
        transcript: 'Accident debris on Bahria Phase 4 boulevard, one lane blocked.',
        canonical_en: 'accident debris blocking one lane of boulevard, bahria town phase 4' },
    ],
    assignments: [{ org: 'rescue1122', status: 'resolved', alerted: 12, claimed: 15, in_progress: 22, resolved: 70,
      note: 'Road cleared.' }],
  },
  {
    key: 'stray_dogs', category: 'safety', urgency: 'low', status: 'unconfirmed', confidence: 0.38,
    area: 'F-10/2 park, Islamabad', hints: ['F-10/2', 'park', 'Islamabad'],
    lat: 33.6950, lng: 73.0130, hoursAgo: 28,
    title_en: 'Pack of stray dogs near F-10 park',
    title_ur: 'ایف ٹین پارک کے قریب آوارہ کتوں کا غول',
    summary_en: 'A pack of stray dogs chases children and cyclists near the F-10/2 park every evening.',
    summary_ur: 'ایف ٹین ٹو پارک کے قریب آوارہ کتوں کا غول ہر شام بچوں اور سائیکل سواروں کے پیچھے بھاگتا ہے۔',
    ai_reason: 'Single report, low urgency.',
    reports: [
      { by: U.c3, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'ایف ٹین ٹو پارک کے پاس آوارہ کتے ہیں، بچوں کے پیچھے بھاگتے ہیں',
        canonical_en: 'pack of stray dogs chasing children near park, f-10/2 islamabad' },
    ],
  },
  {
    key: 'fake_fire', category: 'fire', urgency: 'high', status: 'disputed', confidence: 0.18,
    area: 'G-10 Markaz, Islamabad', hints: ['G-10 Markaz', 'plaza', 'Islamabad'],
    lat: 33.6840, lng: 73.0130, hoursAgo: 16,
    title_en: 'Fire reported at G-10 Markaz plaza',
    title_ur: 'جی ٹین مرکز پلازہ میں آگ کی اطلاع',
    summary_en: 'A fire was reported in a G-10 Markaz plaza, but people on the spot say there is no fire.',
    summary_ur: 'جی ٹین مرکز کے ایک پلازہ میں آگ کی اطلاع دی گئی، لیکن موقع پر موجود لوگوں کا کہنا ہے کہ کوئی آگ نہیں لگی۔',
    ai_reason: 'Single text report without a photo; 3 people nearby disputed it.',
    reports: [
      { by: U.c5, modes: ['text'], language: 'en', min: 0, at: [0, 0],
        transcript: 'FIRE in G-10 markaz plaza!!! come fast',
        canonical_en: 'fire in plaza, g-10 markaz islamabad' },
    ],
    votes: [[U.c1, 'dispute'], [U.c3, 'dispute'], [U.c4, 'dispute']],
  },
  {
    key: 'ration_needed', category: 'food', urgency: 'high', status: 'verified', confidence: 0.82,
    area: 'Near Nullah Lai, Gawalmandi, Rawalpindi', hints: ['Gawalmandi', 'Nullah Lai', 'Rawalpindi'],
    lat: 33.6085, lng: 73.0610, hoursAgo: 10,
    food: { type: 'dry rations needed' },
    title_en: 'Flood-hit families need food rations',
    title_ur: 'سیلاب سے متاثرہ خاندانوں کو راشن کی ضرورت',
    summary_en: 'About 15 families near Nullah Lai in Gawalmandi lost their food stock to flood water and need rations today.',
    summary_ur: 'گوالمنڈی میں نالہ لئی کے قریب تقریباً پندرہ خاندانوں کا راشن سیلابی پانی میں خراب ہو گیا ہے، انہیں آج راشن چاہیے۔',
    ai_reason: '2 independent reporters (voice and text) from the same street.',
    reports: [
      { by: U.c4, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'گوالمنڈی نالہ لئی کے پاس پندرہ گھروں کا راشن پانی میں خراب ہو گیا ہے، کھانے کو کچھ نہیں',
        canonical_en: 'flood affected families need food rations near nullah lai, gawalmandi rawalpindi' },
      { by: U.c5, modes: ['text'], language: 'ur', min: 30, at: [35, -25],
        transcript: 'نالہ لئی کے قریب سیلاب والے گھروں کو راشن چاہیے',
        canonical_en: 'food rations needed for flooded homes near nullah lai, gawalmandi rawalpindi' },
    ],
    assignments: [{ org: 'foodbank', status: 'claimed', alerted: 31, claimed: 55 }],
  },
  {
    key: 'streetlights_out', category: 'other', urgency: 'low', status: 'unconfirmed', confidence: 0.35,
    area: 'Back service road, Blue Area, Islamabad', hints: ['Blue Area', 'service road', 'Islamabad'],
    lat: 33.7065, lng: 73.0615, hoursAgo: 36,
    title_en: 'Streetlights off along Blue Area service road',
    title_ur: 'بلیو ایریا سروس روڈ کی اسٹریٹ لائٹس بند',
    summary_en: 'Most streetlights on the Blue Area back service road have been off for a week, making it unsafe at night.',
    summary_ur: 'بلیو ایریا کی پچھلی سروس روڈ کی زیادہ تر اسٹریٹ لائٹس ایک ہفتے سے بند ہیں، رات کو یہاں سے گزرنا غیر محفوظ ہے۔',
    ai_reason: 'Single report, low urgency.',
    reports: [
      { by: U.c3, modes: ['text'], language: 'en', min: 0, at: [0, 0],
        transcript: 'Street lights on the Blue Area back road are off for a week, very dark at night.',
        canonical_en: 'streetlights not working on back service road, blue area islamabad' },
    ],
  },
  {
    key: 'fever_cases', category: 'health', urgency: 'medium', status: 'unconfirmed', confidence: 0.44,
    area: 'Katchi abadi, G-11, Islamabad', hints: ['G-11', 'katchi abadi', 'Islamabad'],
    lat: 33.6655, lng: 73.0020, hoursAgo: 12,
    title_en: 'Many children with fever in G-11 katchi abadi',
    title_ur: 'جی الیون کچی آبادی میں کئی بچوں کو بخار',
    summary_en: 'Several children in the G-11 katchi abadi have high fever and diarrhoea; families cannot reach a clinic.',
    summary_ur: 'جی الیون کی کچی آبادی میں کئی بچوں کو تیز بخار اور اسہال ہے، گھر والے کلینک تک نہیں پہنچ پا رہے۔',
    ai_reason: 'Single voice report; awaiting confirmation.',
    reports: [
      { by: U.c5, modes: ['voice'], language: 'ur', min: 0, at: [0, 0],
        transcript: 'جی الیون کچی آبادی میں بہت سے بچوں کو بخار اور دست ہیں، کوئی ڈاکٹر نہیں',
        canonical_en: 'many children with high fever and diarrhoea in katchi abadi, g-11 islamabad' },
    ],
  },
]

// spam report: stored, flagged, never clustered
const SPAM = {
  key: 'spam_iphone', by: U.c5, lat: 33.7195, lng: 73.0590, hoursAgo: 19, modes: ['text'], language: 'en',
  transcript: 'lol testing this app, free iphone giveaway at F-7 call me',
  canonical_en: 'free iphone giveaway message, f-7 islamabad',
  spam_reason: 'Not a local civic issue (joke / advertisement).',
}

// ------------------------------------------------------------------ build rows
function buildRows(userIds) {
  const clusters = []
  const reports = []
  const assignments = []
  const votes = []
  const notifications = []
  const placed = []

  for (const c of CLUSTERS) {
    const clusterId = sid(`cluster:${c.key}`)
    const t0 = NOW - c.hoursAgo * HOUR
    const lastMin = Math.max(...c.reports.map((r) => r.min))
    const food = c.food
    const safeUntil = food?.safeHoursFromNow ? iso(NOW + food.safeHoursFromNow * HOUR) : null
    const firstAlert = c.assignments?.length ? Math.min(...c.assignments.map((a) => a.alerted)) : null
    const claimer = c.assignments?.find((a) => a.status !== 'alerted')
    const claimerOrg = claimer ? ORG_BY_KEY[claimer.org] : null

    clusters.push({
      id: clusterId,
      category: c.category,
      urgency: c.urgency,
      centroid: ewkt(c.lat, c.lng),
      confidence: c.confidence,
      ai_reason: c.ai_reason,
      status: c.status,
      title_en: c.title_en,
      title_ur: c.title_ur,
      summary_en: c.summary_en,
      summary_ur: c.summary_ur,
      photo_path: null,
      food_servings: food?.servings ?? null,
      food_type: food?.type ?? null,
      safe_until: safeUntil,
      claimed_org_id: claimerOrg ? sid(`org:${claimerOrg.key}`) : null,
      claimed_org_name: claimerOrg ? claimerOrg.name : null,
      routed_at: firstAlert != null ? iso(t0 + firstAlert * MIN) : null,
      nearby_notified_at: c.notified ? iso(t0 + (lastMin + 1) * MIN) : null,
      created_at: iso(t0),
      last_report_at: iso(t0 + lastMin * MIN),
    })

    c.reports.forEach((r, i) => {
      const [lat, lng] = offset(c.lat, c.lng, r.at[0], r.at[1])
      placed.push({ key: `${c.key}#${i}`, lat, lng })
      reports.push({
        id: sid(`report:${c.key}:${i}`),
        reporter_id: userIds[r.by],
        client_id: `seed-${c.key}-${i}`,
        cluster_id: clusterId,
        category: c.category,
        urgency: c.urgency,
        title_en: c.title_en,
        title_ur: c.title_ur,
        summary_en: c.summary_en,
        summary_ur: c.summary_ur,
        canonical_en: r.canonical_en,
        transcript: r.transcript,
        language: r.language,
        input_modes: r.modes,
        location: ewkt(lat, lng),
        location_source: 'gps',
        address_text: c.area,
        location_hints: c.hints,
        status: c.status,
        confidence: c.confidence,
        ai_reason: c.ai_reason,
        is_spam: false,
        spam_reason: null,
        photo_check: null,
        extraction: {
          seed: true, category: c.category, urgency: c.urgency, title_en: c.title_en, title_ur: c.title_ur,
          summary_en: c.summary_en, summary_ur: c.summary_ur, canonical_en: r.canonical_en,
          location_hints: c.hints, language: r.language, is_spam: false, spam_reason: null,
          food: food?.servings ? { food_type: food.type, servings_estimate: food.servings, safe_hours: food.safeHoursFromNow } : null,
          confidence_notes: 'seeded demo data',
        },
        ai_provider: 'openai',
        food_servings: food?.servings ?? null,
        food_type: food?.type ?? null,
        safe_until: safeUntil,
        created_at: iso(t0 + r.min * MIN),
      })
    })

    const primaryReportId = sid(`report:${c.key}:0`)
    for (const [email, vote] of c.votes ?? []) {
      if (c.reports.some((r) => r.by === email)) throw new Error(`seed bug: ${email} votes on own cluster ${c.key}`)
      votes.push({ report_id: primaryReportId, cluster_id: clusterId, user_id: userIds[email], vote,
        created_at: iso(t0 + (lastMin + 20) * MIN) })
    }

    for (const a of c.assignments ?? []) {
      const org = ORG_BY_KEY[a.org]
      const orgId = sid(`org:${org.key}`)
      const at = (m) => (m == null ? null : iso(t0 + m * MIN))
      const ownerId = userIds[org.owner]
      assignments.push({
        id: sid(`assignment:${c.key}:${org.key}`),
        cluster_id: clusterId,
        report_id: primaryReportId,
        org_id: orgId,
        status: a.status,
        distance_m: Math.round(haversine(org.lat, org.lng, c.lat, c.lng)),
        note: a.note ?? null,
        alerted_at: at(a.alerted),
        claimed_at: at(a.claimed),
        claimed_by: a.claimed != null ? ownerId : null,
        in_progress_at: at(a.in_progress),
        resolved_at: at(a.resolved),
      })

      const isFood = c.category === 'food'
      notifications.push({
        id: sid(`notif:${c.key}:${org.key}:alert`),
        user_id: ownerId,
        report_id: primaryReportId,
        cluster_id: clusterId,
        type: isFood ? 'food_alert' : 'new_assignment',
        title_en: `${isFood ? 'Food alert' : 'New alert'}: ${c.title_en}`,
        title_ur: `${isFood ? 'کھانے کا الرٹ' : 'نیا الرٹ'}: ${c.title_ur}`,
        body_en: c.summary_en,
        body_ur: c.summary_ur,
        data: { cluster_id: clusterId, url: `/pin/${clusterId}`, category: c.category, urgency: c.urgency },
        read_at: a.status === 'alerted' ? null : at(a.claimed ?? a.alerted + 1),
        created_at: at(a.alerted),
      })

      // reporters hear back when an organisation takes the case
      if (a.status !== 'alerted') {
        const statusText = {
          claimed: [`${org.name} has taken responsibility`, `${org.name} نے ذمہ داری لے لی ہے`],
          in_progress: [`${org.name} is working on it`, `${org.name} اس پر کام کر رہا ہے`],
          resolved: [`Resolved by ${org.name}`, `${org.name} نے مسئلہ حل کر دیا`],
        }[a.status]
        const when = a.resolved ?? a.in_progress ?? a.claimed
        for (const email of new Set(c.reports.map((r) => r.by))) {
          notifications.push({
            id: sid(`notif:${c.key}:${org.key}:${email}:${a.status}`),
            user_id: userIds[email],
            report_id: primaryReportId,
            cluster_id: clusterId,
            type: 'status_change',
            title_en: statusText[0],
            title_ur: statusText[1],
            body_en: c.title_en,
            body_ur: c.title_ur,
            data: { cluster_id: clusterId, url: `/pin/${clusterId}`, status: a.status },
            read_at: c.hoursAgo > 12 ? at(when + 30) : null,
            created_at: at(when),
          })
        }
      }
    }
  }

  // spam
  placed.push({ key: SPAM.key, lat: SPAM.lat, lng: SPAM.lng })
  reports.push({
    id: sid(`report:${SPAM.key}`),
    reporter_id: userIds[SPAM.by],
    client_id: `seed-${SPAM.key}`,
    cluster_id: null,
    category: 'other',
    urgency: 'low',
    title_en: 'Not a civic issue',
    title_ur: 'شہری مسئلہ نہیں',
    summary_en: 'Joke / advertisement message, not a local issue.',
    summary_ur: 'مذاق یا اشتہار کا پیغام، کوئی مقامی مسئلہ نہیں۔',
    canonical_en: SPAM.canonical_en,
    transcript: SPAM.transcript,
    language: SPAM.language,
    input_modes: SPAM.modes,
    location: ewkt(SPAM.lat, SPAM.lng),
    location_source: 'gps',
    address_text: 'F-7, Islamabad',
    location_hints: ['F-7', 'Islamabad'],
    status: 'unconfirmed',
    confidence: 0,
    ai_reason: SPAM.spam_reason,
    is_spam: true,
    spam_reason: SPAM.spam_reason,
    photo_check: null,
    extraction: { seed: true, is_spam: true, spam_reason: SPAM.spam_reason },
    ai_provider: 'openai',
    food_servings: null,
    food_type: null,
    safe_until: null,
    created_at: iso(NOW - SPAM.hoursAgo * HOUR),
  })

  // guard: demo zones stay empty
  for (const p of placed) {
    for (const z of DEMO_ZONES) {
      const d = haversine(p.lat, p.lng, z.lat, z.lng)
      if (d < DEMO_ZONE_CLEARANCE_M) throw new Error(`seed bug: ${p.key} is ${Math.round(d)} m from demo zone "${z.name}"`)
    }
  }

  return { clusters, reports, assignments, votes, notifications }
}

// ------------------------------------------------------------------ steps
async function ensureUsers() {
  const existing = new Map()
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    for (const u of data.users) if (u.email) existing.set(u.email.toLowerCase(), u.id)
    if (data.users.length < 1000) break
  }

  const ids = {}
  let created = 0
  for (const a of ACCOUNTS) {
    // signup metadata never carries admin (the trigger would ignore it anyway); admin is set on the profile below
    const user_metadata = { role: a.role === 'admin' ? 'citizen' : a.role, display_name: a.display_name, language: a.language }
    let id = existing.get(a.email)
    if (!id) {
      const res = await db.auth.admin.createUser({ email: a.email, password: DEMO_PASSWORD, email_confirm: true, user_metadata })
      if (res.error) throw new Error(`createUser ${a.email}: ${res.error.message}`)
      id = res.data.user.id
      created++
    } else {
      const res = await db.auth.admin.updateUserById(id, { password: DEMO_PASSWORD, email_confirm: true, user_metadata })
      if (res.error) throw new Error(`updateUser ${a.email}: ${res.error.message}`)
    }
    ids[a.email] = id
  }

  must(await db.from('profiles').upsert(ACCOUNTS.map((a) => ({
    id: ids[a.email],
    role: a.role,
    display_name: a.display_name,
    language: a.language,
    is_demo: true,
    trust_score: a.trust,
  })), { onConflict: 'id' }), 'profiles upsert')

  return { ids, created }
}

async function seedOrgs(userIds) {
  must(await db.from('organizations').upsert(ORGS.map((o) => ({
    id: sid(`org:${o.key}`),
    owner_id: userIds[o.owner],
    name: o.name,
    org_type: o.org_type,
    categories: o.categories,
    center: ewkt(o.lat, o.lng),
    radius_m: o.radius_m,     // service_area = ST_Buffer(center, radius_m) is filled by the DB trigger
    phone: null,              // demo orgs: no real phone numbers (avoid accidental calls to real helplines)
    approved: true,
  })), { onConflict: 'id' }), 'organizations upsert')
}

async function backfillEmbeddings(onlyMissing) {
  let q = db.from('reports').select('id, canonical_en').like('client_id', 'seed-%').not('canonical_en', 'is', null)
  if (onlyMissing) q = q.is('embedding', null)
  const rows = must(await q, 'select seeded reports')
  if (!rows.length) return 0
  return await storeEmbeddings(rows)
}

async function count(table, filter) {
  let q = db.from(table).select('*', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count: n, error } = await q
  if (error) throw new Error(`count ${table}: ${error.message}`)
  return n
}

// ------------------------------------------------------------------ main
async function main() {
  console.log(`Awaaz seed -> ${SUPABASE_URL}${EMBED_ONLY ? ' (embeddings only)' : ''}`)

  if (EMBED_ONLY) {
    if (!OPENAI_API_KEY) {
      console.log('OPENAI_API_KEY is empty (supabase/functions/.env) — nothing to do.')
      return
    }
    const n = await backfillEmbeddings(true)
    console.log(`Embedded ${n} seeded report(s) with ${EMBED_MODEL} (${EMBED_DIMS} dims).`)
    return
  }

  const { ids, created } = await ensureUsers()
  console.log(`users: ${ACCOUNTS.length} demo accounts (${created} created), password = DEMO_PASSWORD from src/lib/demoAccounts.ts`)

  await seedOrgs(ids)
  console.log(`organizations: ${ORGS.length} approved`)

  const rows = buildRows(ids)

  must(await db.from('clusters').upsert(rows.clusters, { onConflict: 'id' }), 'clusters upsert')
  must(await db.from('reports').upsert(rows.reports, { onConflict: 'id' }), 'reports upsert')
  must(await db.from('assignments').upsert(rows.assignments, { onConflict: 'cluster_id,org_id' }), 'assignments upsert')

  // reset votes on seeded clusters to exactly the seeded set
  const seededClusterIds = rows.clusters.map((c) => c.id)
  const seededVoterIds = [...new Set(Object.values(U).map((e) => ids[e]))]
  must(await db.from('report_votes').delete().in('cluster_id', seededClusterIds).in('user_id', seededVoterIds), 'votes reset')
  must(await db.from('report_votes').insert(rows.votes), 'votes insert')

  must(await db.from('notifications').upsert(rows.notifications, { onConflict: 'id' }), 'notifications upsert')

  for (const c of rows.clusters) must(await db.rpc('recompute_cluster', { p_cluster_id: c.id }), `recompute ${c.id}`)

  if (OPENAI_API_KEY) {
    const n = await backfillEmbeddings(false)
    console.log(`embeddings: ${n} report(s) embedded with ${EMBED_MODEL} (${EMBED_DIMS} dims)`)
  } else {
    console.log('NOTE: OPENAI_API_KEY is empty in supabase/functions/.env — seeded reports have NULL embeddings.')
    console.log('      Fill it in and run `node scripts/seed.mjs --embed` to backfill.')
  }

  const pins = must(await db.from('map_pins').select('id, status, report_count, reporter_count, confirm_count, dispute_count')
    .in('id', seededClusterIds), 'map_pins')
  const byStatus = pins.reduce((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {})

  console.log('seeded:', {
    clusters: rows.clusters.length,
    reports: rows.reports.length,
    spam_reports: rows.reports.filter((r) => r.is_spam).length,
    assignments: rows.assignments.length,
    votes: rows.votes.length,
    notifications: rows.notifications.length,
  })
  console.log('map pins (seeded) by status:', byStatus)
  console.log('database totals:', {
    profiles: await count('profiles'),
    organizations: await count('organizations'),
    clusters: await count('clusters'),
    reports: await count('reports'),
    reports_with_embedding: await count('reports', (q) => q.not('embedding', 'is', null)),
    assignments: await count('assignments'),
    report_votes: await count('report_votes'),
    notifications: await count('notifications'),
    map_pins: await count('map_pins'),
  })
}

main().catch((e) => {
  console.error('seed failed:', e.message ?? e)
  process.exit(1)
})
