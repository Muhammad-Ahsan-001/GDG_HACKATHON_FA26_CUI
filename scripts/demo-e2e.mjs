// End-to-end check of the hackathon demo script against the LIVE Supabase backend.
//   node scripts/demo-e2e.mjs            run the 4 demo steps, print PASS/FAIL
//   node scripts/demo-e2e.mjs --cleanup  delete the clusters/reports created by previous e2e runs
// Needs: .secrets/supabase.env (URL, anon + service keys), supabase/functions/.env (OPENAI_API_KEY, for demo media).
import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = (file) => Object.fromEntries(
  (existsSync(file) ? readFileSync(file, 'utf8') : '').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const S = env(join(ROOT, '.secrets/supabase.env'))
const F = env(join(ROOT, 'supabase/functions/.env'))
const URL = S.SUPABASE_URL
const ANON = S.SUPABASE_KEY_ANON
const SERVICE = S.SUPABASE_KEY_SERVICE_ROLE
const OPENAI = F.OPENAI_API_KEY
const PASSWORD = 'AwaazDemo#2026'
const MEDIA = join(ROOT, '.secrets/demo-media')
const TAG = 'e2e-'   // client_id prefix so --cleanup can find our rows

const SCHOOL = { lat: 33.6888, lng: 73.0262 }          // G-9/4 "Street 5 school"
const SCHOOL_2 = { lat: 33.68905, lng: 73.02645 }      // ~35 m away
const WEDDING_HALL = { lat: 33.6905, lng: 73.0335 }    // G-9 Markaz

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`)
  if (!cond) failures++
  return cond
}

async function login(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`login ${email}: ${error.message}`)
  return { c, uid: data.user.id }
}

async function invoke(c, name, body) {
  const t = Date.now()
  const { data, error } = await c.functions.invoke(name, { body })
  if (error) {
    let detail = error.message
    try { detail = JSON.stringify(await error.context.json()) } catch { /* not json */ }
    throw new Error(`${name} failed: ${detail}`)
  }
  console.log(`      ${name} ${Date.now() - t} ms`)
  return data
}

// ---- demo media (generated once with OpenAI, cached in .secrets/demo-media) ----
async function openai(path, body, binary) {
  const r = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`openai ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json()
}

async function demoAudio() {
  const f = join(MEDIA, 'street5-urdu.mp3')
  if (!existsSync(f)) {
    const buf = await openai('audio/speech', {
      model: 'gpt-4o-mini-tts', voice: 'marin', response_format: 'mp3',
      input: 'سٹریٹ فائیو کے سکول کے باہر گٹر کھلا ہے، بچوں کے گرنے کا خطرہ ہے۔',
      instructions: 'Speak like a worried Pakistani parent leaving a quick voice note, natural Urdu.',
    }, true)
    writeFileSync(f, buf)
  }
  return readFileSync(f)
}

async function demoImage(name, prompt) {
  const f = join(MEDIA, name)
  if (!existsSync(f)) {
    const model = process.env.DEMO_IMAGE_MODEL || 'gpt-image-2'
    const res = await openai('images/generations', { model, prompt, size: '1024x1024', n: 1 })
    const b64 = res.data?.[0]?.b64_json
    if (!b64) throw new Error('no image returned')
    writeFileSync(f, Buffer.from(b64, 'base64'))
  }
  return readFileSync(f)
}

async function uploadImage(c, clientId, buf) {
  const path = `${clientId}/0.jpg`
  const { error } = await c.storage.from('report-images').upload(path, buf, { contentType: 'image/png', upsert: false })
  if (error) throw new Error(`image upload: ${error.message}`)
  return path
}

async function cleanup() {
  const { data: reps } = await admin.from('reports').select('id, cluster_id').like('client_id', `${TAG}%`)
  const clusterIds = [...new Set((reps ?? []).map((r) => r.cluster_id).filter(Boolean))]
  if (clusterIds.length) {
    await admin.from('notifications').delete().in('cluster_id', clusterIds)
    await admin.from('assignments').delete().in('cluster_id', clusterIds)
    await admin.from('report_votes').delete().in('cluster_id', clusterIds)
    await admin.from('clusters').update({ primary_report_id: null }).in('id', clusterIds)
  }
  if (reps?.length) await admin.from('reports').delete().in('id', reps.map((r) => r.id))
  if (clusterIds.length) await admin.from('clusters').delete().in('id', clusterIds)
  console.log(`cleanup: removed ${reps?.length ?? 0} e2e reports, ${clusterIds.length} clusters`)
}

async function main() {
  if (process.argv.includes('--cleanup')) return cleanup()
  if (!OPENAI) throw new Error('OPENAI_API_KEY is empty in supabase/functions/.env')
  mkdirSync(MEDIA, { recursive: true })
  await cleanup()
  const run = Date.now().toString(36)

  // ---- Step 1: Urdu voice note + photo -> High Hazard pin, Unconfirmed, routed early to Rescue 1122 ----
  console.log('\nStep 1 — citizen1 Urdu voice note + photo')
  const a = await login('citizen1@awaaz.demo')
  const id1 = `${TAG}${run}-1`
  const audioPath = `${a.uid}/${id1}.mp3`
  let up = await a.c.storage.from('report-audio').upload(audioPath, await demoAudio(), { contentType: 'audio/mpeg', upsert: true })
  if (up.error) throw new Error(`audio upload: ${up.error.message}`)
  let images = []
  try {
    const img = await demoImage('manhole.png', 'Smartphone photo of an uncovered open sewer manhole on a residential street outside a school gate in Islamabad, Pakistan, daytime, realistic, no text')
    images = [await uploadImage(a.c, id1, img)]
  } catch (e) { console.log(`      (photo skipped: ${e.message})`) }
  const r1 = await invoke(a.c, 'process-report', {
    client_id: id1, audio_path: audioPath, image_paths: images, lat: SCHOOL.lat, lng: SCHOOL.lng,
    accuracy_m: 15, location_source: 'gps', language: 'auto', ui_language: 'ur',
  })
  console.log(`      heard: ${r1.transcript}\n      → ${r1.category}/${r1.urgency} "${r1.title_en}" status=${r1.status} conf=${r1.confidence}`)
  ok(r1.category === 'hazard', 'category = hazard', r1.category)
  ok(['high', 'critical'].includes(r1.urgency), 'urgency high/critical', r1.urgency)
  ok(r1.status === 'unconfirmed', 'status = unconfirmed', r1.status)
  ok(r1.routed?.some((o) => o.org_type === 'rescue_1122'), 'routed early to Rescue 1122', JSON.stringify(r1.routed))
  const pin1 = await a.c.from('map_pins').select('id,status,report_count').eq('id', r1.cluster_id).maybeSingle()
  ok(pin1.data?.report_count === 1, 'pin visible on public map with 1 report')

  // ---- Step 2: English text of the same issue -> joins same pin, Verified ----
  console.log('\nStep 2 — citizen2 types the same problem in English')
  const b = await login('citizen2@awaaz.demo')
  const r2 = await invoke(b.c, 'process-report', {
    client_id: `${TAG}${run}-2`, text: 'open manhole near the school on Street 5', lat: SCHOOL_2.lat, lng: SCHOOL_2.lng,
    accuracy_m: 20, location_source: 'gps', language: 'auto', ui_language: 'en',
  })
  console.log(`      → dup=${r2.is_duplicate} sim=${r2.similarity} status=${r2.status} conf=${r2.confidence} reason=${r2.ai_reason}`)
  ok(r2.cluster_id === r1.cluster_id && r2.is_duplicate, 'joined the same pin', `sim=${r2.similarity}`)
  ok(r2.status === 'verified', 'status = verified', `${r2.status} @ ${r2.confidence}`)
  const pin2 = await b.c.from('map_pins').select('status,report_count').eq('id', r1.cluster_id).maybeSingle()
  ok(pin2.data?.report_count === 2 && pin2.data?.status === 'verified', 'map pin shows 2 reports, Verified')

  // ---- Step 3: Rescue 1122 claims -> starts -> resolves; citizen sees Resolved ----
  console.log('\nStep 3 — Rescue 1122 dashboard')
  const r = await login('rescue1122@awaaz.demo')
  const { data: asg } = await r.c.from('my_assignments').select('*').eq('cluster_id', r1.cluster_id)
  ok(asg?.length === 1, 'assignment on Rescue 1122 dashboard')
  const notif = await r.c.from('notifications').select('id,type').eq('cluster_id', r1.cluster_id)
  ok((notif.data?.length ?? 0) > 0, 'Rescue 1122 got an alert notification', notif.data?.map((n) => n.type).join(','))
  for (const action of ['claim', 'start', 'resolve']) {
    const res = await invoke(r.c, 'assignment-action', { assignment_id: asg[0].assignment_id, action })
    ok(Boolean(res.status), `action ${action}`, `${res.status} / cluster ${res.cluster_status}`)
  }
  const mine = await a.c.from('reports').select('status').eq('client_id', id1).maybeSingle()
  ok(mine.data?.status === 'resolved', 'citizen1 sees Resolved on own report', mine.data?.status)
  const cn = await a.c.from('notifications').select('type').eq('cluster_id', r1.cluster_id)
  ok((cn.data?.length ?? 0) > 0, 'citizen1 got status notifications', cn.data?.map((n) => n.type).join(','))

  // ---- Step 4: caterer photographs leftover wedding food -> ~120 servings, safe-until, shelter claims ----
  console.log('\nStep 4 — caterer food rescue')
  const cat = await login('citizen3@awaaz.demo')
  const id4 = `${TAG}${run}-4`
  let foodImgs = []
  try {
    const img = await demoImage('wedding-food.png', 'Smartphone photo of large steel degs and trays of leftover biryani, korma and naan after a Pakistani wedding in a marquee kitchen, enough for about 120 people, realistic, no text')
    foodImgs = [await uploadImage(cat.c, id4, img)]
  } catch (e) { console.log(`      (photo skipped: ${e.message})`) }
  const r4 = await invoke(cat.c, 'process-report', {
    client_id: id4, image_paths: foodImgs, text: 'Shadi ka khana bach gaya hai, takreeban 120 logon ke liye. Koi shelter le jaye.',
    lat: WEDDING_HALL.lat, lng: WEDDING_HALL.lng, accuracy_m: 25, location_source: 'gps', language: 'auto', ui_language: 'ur',
  })
  console.log(`      → ${r4.category} food=${JSON.stringify(r4.food)} routed=${JSON.stringify(r4.routed)}`)
  ok(r4.category === 'food', 'category = food')
  ok(r4.food && r4.food.servings >= 80 && r4.food.servings <= 200, 'servings estimate ≈ 120', String(r4.food?.servings))
  ok(r4.food && new Date(r4.food.safe_until) > new Date(), 'safe-until timer set', r4.food?.safe_until)
  const sh = await login('shelter@awaaz.demo')
  const { data: shAsg } = await sh.c.from('my_assignments').select('*').eq('cluster_id', r4.cluster_id)
  ok(shAsg?.length === 1, 'nearby shelter received the food alert')
  if (shAsg?.length) {
    const res = await invoke(sh.c, 'assignment-action', { assignment_id: shAsg[0].assignment_id, action: 'claim' })
    ok(res.status === 'claimed', 'shelter claimed the food')
  }

  console.log(`\n${failures === 0 ? 'ALL DEMO STEPS PASSED' : `${failures} check(s) failed`}`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => { console.error('ERROR', e.message); process.exitCode = 1 })
