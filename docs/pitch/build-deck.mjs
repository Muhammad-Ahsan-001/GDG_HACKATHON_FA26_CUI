// Builds docs/pitch/deck.html (light theme, 9 slides, 1920x1080). Render: see bottom of file.
import * as L from 'lucide'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const icon = (name, size = 48, color = 'currentColor', sw = 2) => {
  const node = L[name]
  if (!node) throw new Error('icon ' + name)
  const kids = node.map(([t, a]) => `<${t} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${kids}</svg>`
}
const qr = readFileSync(join(HERE, 'img/qr.svg'), 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!DOCTYPE[^>]*>/, '')

const CAT = {
  hazard: ['#EA580C', 'TriangleAlert', 'Hazards', 'خطرات'],
  flood: ['#2563EB', 'Waves', 'Floods', 'سیلاب'],
  water: ['#0891B2', 'Droplets', 'Water & sanitation', 'پانی'],
  fire: ['#DC2626', 'Flame', 'Fire', 'آگ'],
  health: ['#DB2777', 'HeartPulse', 'Health', 'صحت'],
  food: ['#16A34A', 'Utensils', 'Food rescue', 'کھانا'],
  safety: ['#7C3AED', 'ShieldAlert', 'Public safety', 'حفاظت'],
}
const SDG = [
  [1, '#E5243B', 'No poverty'], [2, '#DDA63A', 'Zero hunger'], [3, '#4C9F38', 'Good health'],
  [5, '#FF3A21', 'Gender equality'], [6, '#26BDE2', 'Clean water'], [9, '#FD6925', 'Infrastructure'],
  [10, '#DD1367', 'Reduced inequalities'], [11, '#FD9D24', 'Sustainable cities'], [12, '#BF8B2E', 'Less food waste'],
  [13, '#3F7E44', 'Climate action'], [16, '#00689D', 'Peace & justice'], [17, '#19486A', 'Partnerships'],
]

const foot = (n) => `<div class="foot"><span class="brand">${icon('Mic', 26, '#0f766e', 2.4)} Awaaz <span class="ur">آواز</span></span><span>Team AVEZEA · Build with Google Hackathon · GDGoC CUI</span><span class="num">${n} / 9</span></div>`

const slides = []

// 1 — Title
slides.push(`<section class="s title">
  <div class="blob b1"></div><div class="blob b2"></div>
  <div class="tl">
    <div class="pill">${icon('Sparkles', 28, '#0f766e')} Build with Google Hackathon · GDGoC CUI</div>
    <h1 class="ur big">آواز</h1>
    <h1 class="en">Awaaz</h1>
    <p class="tag"><span class="ur">آپ کی آواز، آپ کا محلہ</span><br/>Your voice. Your neighbourhood.</p>
    <p class="lead">A voice-first, AI-verified community map: anyone — even someone who cannot read — reports a local problem by speaking, and the right responders are alerted.</p>
    <div class="team"><div class="tname">Team AVEZEA</div><div>Muhammad Ahsan · Muhammad Bilal</div></div>
  </div>
  <div class="tr">
    <div class="mic">${icon('Mic', 150, '#ffffff', 2)}<span class="ring r1"></span><span class="ring r2"></span></div>
    <div class="qrbox">${qr}<div class="url">awaaz.avezea.com</div></div>
  </div>
</section>`)

// 2 — The idea
slides.push(`<section class="s">
  <div class="kicker">The idea</div>
  <h2>One voice-first platform for <span class="hl">every</span> local problem</h2>
  <div class="cols2">
    <div class="card big-quote">
      ${icon('Quote', 54, '#14b8a6')}
      <p>Instead of building one small app for one small problem, we built <b>one shared pipeline</b> that any community issue can flow through — so each new domain only needs a category and a responder.</p>
    </div>
    <div class="stack">
      ${[
        ['Mic', 'Speak, snap or type', 'Urdu, Roman Urdu, Punjabi or English'],
        ['Sparkles', 'AI understands & verifies', 'Category, urgency, duplicates, confidence'],
        ['Siren', 'The right people act', 'Rescue 1122, fire, police, water, NGOs'],
        ['CircleCheckBig', 'Citizens see it resolved', 'Live status, notifications, accountability'],
      ].map(([i, a, b]) => `<div class="row">${icon(i, 40, '#0f766e')}<div><b>${a}</b><span>${b}</span></div></div>`).join('')}
    </div>
  </div>
  ${foot(2)}
</section>`)

// 3 — How it works
const steps = [
  ['Mic', '#0f766e', 'Speak', 'Voice note, photo or text — or just talk to the AI'],
  ['MessagesSquare', '#14b8a6', 'AI asks', 'Up to 3 short spoken follow-ups with tap-able icon answers'],
  ['ShieldCheck', '#16a34a', 'AI verifies', 'Links duplicates across languages, checks photos, scores confidence'],
  ['Send', '#f59e0b', 'Routes', 'Nearest matching responders get a push alert instantly'],
  ['CircleCheckBig', '#0891b2', 'Resolved', 'Claim → in progress → resolved, citizen notified'],
]
slides.push(`<section class="s">
  <div class="kicker">How it works</div>
  <h2>Speak → understand → verify → route → resolve</h2>
  <div class="flow">${steps.map(([i, c, a, b], k) => `
    <div class="step"><div class="sic" style="background:${c}">${icon(i, 62, '#fff')}</div><div class="sn">${k + 1}</div><b>${a}</b><span>${b}</span></div>
    ${k < steps.length - 1 ? `<div class="arrow">${icon('ArrowRight', 44, '#94a3b8')}</div>` : ''}`).join('')}
  </div>
  <div class="example">${icon('Lightbulb', 34, '#b45309')}<div><b>Example:</b> <span class="ur">“سٹریٹ 5 کے سکول کے باہر گٹر کھلا ہے”</span> → a <b>High-urgency Hazard</b> pin appears live and Rescue 1122 is alerted. A second person types “open manhole near the school on Street 5” → it joins the same pin → <b>Verified</b> → claimed → <b>Resolved</b>.</div></div>
  ${foot(3)}
</section>`)

// 4 — Built for everyone
const inc = [
  ['AudioLines', 'Talk to AI, not a form', 'A short spoken conversation collects what responders need: urgency, people affected, injuries, children at risk, landmark…'],
  ['Volume2', 'Voice guidance everywhere', 'Every key screen explains itself aloud in Urdu or English'],
  ['Shapes', 'Icons & colour over text', 'Big buttons, category colours and symbols — usable without reading'],
  ['UserRoundCheck', 'Spoken onboarding', 'Phone number, one spoken question, and the AI reads your profile back for trust'],
  ['WifiOff', 'Works offline', 'Reports are saved on the phone and sent when the internet returns'],
  ['Smartphone', 'Light & installable', 'A PWA built for low-cost Android phones, Urdu right-to-left'],
]
slides.push(`<section class="s">
  <div class="kicker">Inclusion by design</div>
  <h2>Built for people who <span class="hl">cannot read</span> — and everyone else</h2>
  <div class="grid3">${inc.map(([i, a, b]) => `<div class="card f">${`<div class="fi">${icon(i, 44, '#0f766e')}</div>`}<b>${a}</b><span>${b}</span></div>`).join('')}</div>
  ${foot(4)}
</section>`)

// 5 — SOS
slides.push(`<section class="s sos">
  <div class="kicker red">Women's safety</div>
  <h2>A silent <span class="hlr">SOS</span> that listens for danger</h2>
  <div class="cols2">
    <div class="stack">
      ${[
        ['Hand', 'Easy to trigger', 'Hold the SOS button, press volume 3×, shake the phone, or the app-icon shortcut'],
        ['EarOff', 'Completely silent', 'No sounds — vibration only — so an attacker isn’t alerted'],
        ['Ear', 'AI threat detection', 'Recognises threats like “maar dunga”, “bachao”, “I’ll kill you” in Urdu, Punjabi and English'],
        ['MapPinned', 'Police alerted privately', 'Nearest police get live location and audio evidence — never shown on the public map'],
        ['ScrollText', 'Logged for the user', 'Every SOS is recorded in the user’s own SOS log'],
      ].map(([i, a, b]) => `<div class="row">${icon(i, 40, '#dc2626')}<div><b>${a}</b><span>${b}</span></div></div>`).join('')}
    </div>
    <div class="sosvis"><div class="sosbtn">${icon('ShieldAlert', 110, '#fff', 2)}<div>SOS</div><span class="ring r1 red"></span><span class="ring r2 red"></span></div><div class="soscap">Hold 1.5 s · silent · private</div></div>
  </div>
  ${foot(5)}
</section>`)

// 6 — Domains & SDGs
slides.push(`<section class="s">
  <div class="kicker">Big scope, on purpose</div>
  <h2>One platform covers many domains — and <span class="hl">12 SDGs</span></h2>
  <div class="chips">${Object.values(CAT).map(([c, i, en, ur]) => `<span class="chip" style="--c:${c}">${icon(i, 30, '#fff')}<b>${en}</b><span class="ur">${ur}</span></span>`).join('')}<span class="chip" style="--c:#be123c">${icon('Shield', 30, '#fff')}<b>Women’s safety</b></span></div>
  <div class="sdgs">${SDG.map(([n, c, t]) => `<div class="sdg" style="background:${c}"><div class="sdgn">${n}</div><div class="sdgt">${t}</div></div>`).join('')}</div>
  <p class="note">Every domain shares the same pipeline: adding a new one needs only a category and a responder — breadth is our design strength, not a lack of focus.</p>
  ${foot(6)}
</section>`)

// 7 — Responders & trust
const resp = [
  ['LayoutDashboard', 'Live dashboards', 'Rescue 1122, fire brigade, police, water authority, shelters, food banks and health NGOs'],
  ['BellRing', 'Instant alerts', 'Push notifications to the nearest matching organisation'],
  ['ListChecks', 'Claim → resolve', 'Every status change reaches the citizen in real time'],
  ['Utensils', 'Food rescue', 'Leftover food → servings estimate → safe-until countdown → shelter pickup'],
  ['BadgeCheck', 'AI-assessed & accountable', 'Every AI output is labelled; people confirm, dispute and decide'],
  ['Lock', 'Privacy first', 'Reporter identity never public; SOS private to police'],
]
slides.push(`<section class="s">
  <div class="kicker">For responders & cities</div>
  <h2>Verified reports, routed to the right people</h2>
  <div class="grid3">${resp.map(([i, a, b]) => `<div class="card f">${`<div class="fi amber">${icon(i, 44, '#b45309')}</div>`}<b>${a}</b><span>${b}</span></div>`).join('')}</div>
  <div class="adminbar">${icon('MonitorCog', 36, '#0f766e')} <b>Admin console</b> — one place to see every report, pin, user, organisation, assignment and SOS, live.</div>
  ${foot(7)}
</section>`)

// 8 — Technology & AI
const tech = [
  ['OpenAI', 'Speech-to-text, understanding, conversation, photo checks, embeddings, voice', 'Sparkles'],
  ['Google Gemini', 'Gemini models registered in the AI model registry', 'Gem'],
  ['Firebase Cloud Messaging', 'Push notifications to responders and citizens', 'BellRing'],
  ['Supabase', 'Postgres + PostGIS + pgvector, Auth, Storage, Realtime, Edge Functions', 'Database'],
  ['Leaflet + OpenStreetMap', 'Live map, clustering, service areas', 'Map'],
  ['React PWA on Vercel', 'Installable, offline-ready, Urdu RTL', 'AppWindow'],
]
slides.push(`<section class="s">
  <div class="kicker">Technology & responsible AI</div>
  <h2>Built with</h2>
  <div class="grid3 tech">${tech.map(([a, b, i]) => `<div class="card f">${`<div class="fi">${icon(i, 44, '#0f766e')}</div>`}<b>${a}</b><span>${b}</span></div>`).join('')}</div>
  <div class="disc">${icon('Info', 30, '#0f766e')} All AI runs on the server; every AI-generated output in the app is labelled <b>“AI-assessed”</b>.</div>
  ${foot(8)}
</section>`)

// 9 — Thank you
slides.push(`<section class="s title end">
  <div class="blob b1"></div><div class="blob b2"></div>
  <div class="tl">
    <h1 class="ur big">شکریہ</h1>
    <h1 class="en">Thank you</h1>
    <p class="tag">Every voice counts. <span class="ur">ہر آواز اہم ہے۔</span></p>
    <p class="lead">Try it live — speak a problem in your street and watch it reach the right people.</p>
    <div class="team"><div class="tname">Team AVEZEA</div><div>Muhammad Ahsan · Muhammad Bilal</div></div>
  </div>
  <div class="tr"><div class="qrbox lg">${qr}<div class="url">awaaz.avezea.com</div></div></div>
</section>`)

const css = `
@page { size: 1920px 1080px; margin: 0 }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact }
html, body { margin: 0; padding: 0; background: #fff }
body { font-family: Inter, system-ui, sans-serif; color: #1e293b }
.ur { font-family: 'Noto Nastaliq Urdu', serif; }
.s { width: 1920px; height: 1080px; position: relative; overflow: hidden; padding: 76px 120px 0; page-break-after: always; break-after: page;
  background: radial-gradient(1100px 700px at 100% 0%, #ccfbf1 0%, rgba(204,251,241,0) 60%), radial-gradient(900px 600px at 0% 100%, #fef3c7 0%, rgba(254,243,199,0) 60%), #ffffff }
.s:last-child { page-break-after: auto; break-after: auto }
.kicker { display: inline-block; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; font-size: 21px; color: #0f766e; background: #f0fdfa; border: 2px solid #99f6e4; padding: 8px 20px; border-radius: 999px }
.kicker.red { color: #be123c; background: #fff1f2; border-color: #fecdd3 }
h2 { font-size: 60px; line-height: 1.1; margin: 22px 0 36px; color: #134e4a; font-weight: 800; letter-spacing: -.02em; max-width: 1560px }
.hl { color: #0d9488; background: linear-gradient(transparent 62%, #fde68a 62%) }
.hlr { color: #dc2626 }
.foot { position: absolute; left: 120px; right: 120px; bottom: 30px; display: flex; justify-content: space-between; align-items: center; color: #64748b; font-size: 20px; border-top: 2px solid #e2e8f0; padding-top: 16px }
.foot .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; color: #0f766e; font-size: 26px }
.foot .brand .ur { font-size: 24px; line-height: 1 }
.foot .num { font-weight: 700; color: #0f766e }
.card { background: rgba(255,255,255,.92); border: 2px solid #e2e8f0; border-radius: 34px; box-shadow: 0 18px 50px rgba(15,118,110,.08) }
/* title */
.title { display: flex; align-items: center; justify-content: space-between; padding: 0 140px }
.blob { position: absolute; border-radius: 50%; filter: blur(10px); z-index: 0 }
.b1 { width: 900px; height: 900px; right: -200px; top: -260px; background: radial-gradient(circle, #99f6e4 0%, rgba(153,246,228,0) 70%) }
.b2 { width: 800px; height: 800px; left: -260px; bottom: -330px; background: radial-gradient(circle, #fde68a 0%, rgba(253,230,138,0) 70%) }
.tl, .tr { position: relative; z-index: 1 }
.tl { max-width: 1060px }
.pill { display: inline-flex; align-items: center; gap: 12px; font-size: 28px; font-weight: 700; color: #0f766e; background: #fff; border: 2px solid #99f6e4; border-radius: 999px; padding: 12px 26px }
h1 { margin: 0; color: #0f766e; font-weight: 900; letter-spacing: -.03em }
h1.big { font-size: 150px; line-height: 1.75; margin-top: -20px; margin-bottom: 14px; color: #0f766e }
h1.en { font-size: 112px; line-height: 1; margin-top: 0; color: #134e4a }
.tag { font-size: 40px; font-weight: 700; color: #0d9488; margin: 22px 0 0; line-height: 1.5 }
.tag .ur { font-size: 38px }
.lead { font-size: 32px; line-height: 1.5; color: #334155; margin: 26px 0 0; max-width: 980px }
.team { margin-top: 32px; display: inline-block; background: #fff; border: 2px solid #e2e8f0; border-radius: 26px; padding: 22px 34px; font-size: 32px; color: #334155; box-shadow: 0 10px 30px rgba(15,118,110,.08) }
.tname { font-weight: 900; color: #b45309; letter-spacing: .14em; font-size: 26px; margin-bottom: 6px }
.tr { display: flex; flex-direction: column; align-items: center; gap: 60px }
.mic { position: relative; width: 330px; height: 330px; border-radius: 50%; background: linear-gradient(145deg, #14b8a6, #0f766e); display: flex; align-items: center; justify-content: center; box-shadow: 0 30px 80px rgba(13,148,136,.35) }
.ring { position: absolute; border-radius: 50%; border: 6px solid rgba(20,184,166,.35) }
.ring.r1 { inset: -40px } .ring.r2 { inset: -90px; border-color: rgba(20,184,166,.18) }
.ring.red { border-color: rgba(220,38,38,.3) } .ring.r2.red { border-color: rgba(220,38,38,.15) }
.qrbox { background: #fff; border: 2px solid #e2e8f0; border-radius: 28px; padding: 22px 22px 14px; text-align: center; box-shadow: 0 16px 40px rgba(15,118,110,.1) }
.qrbox svg { width: 200px; height: 200px; display: block }
.qrbox.lg svg { width: 380px; height: 380px }
.url { font-weight: 800; color: #0f766e; font-size: 26px; margin-top: 8px }
.qrbox.lg .url { font-size: 36px }
.end h1.big { font-size: 130px; margin-bottom: 34px }
/* idea */
.cols2 { display: grid; grid-template-columns: 1.05fr 1fr; gap: 60px; align-items: start }
.big-quote { padding: 44px 50px }
.big-quote p { font-size: 36px; line-height: 1.45; color: #134e4a; margin: 22px 0 0 }
.stack { display: flex; flex-direction: column; gap: 14px }
.row { display: flex; gap: 24px; align-items: center; background: #fff; border: 2px solid #e2e8f0; border-radius: 24px; padding: 14px 26px }
.row b { display: block; font-size: 28px; color: #134e4a }
.row span { display: block; font-size: 22px; color: #64748b; margin-top: 4px }
/* flow */
.flow { display: flex; align-items: flex-start; justify-content: space-between; margin-top: 10px }
.step { width: 270px; text-align: center; position: relative }
.sic { width: 124px; height: 124px; border-radius: 40px; margin: 0 auto 22px; display: flex; align-items: center; justify-content: center; box-shadow: 0 18px 40px rgba(15,23,42,.12) }
.sn { position: absolute; top: -14px; left: 50%; margin-left: 48px; width: 46px; height: 46px; border-radius: 50%; background: #fff; border: 3px solid #0f766e; color: #0f766e; font-weight: 900; font-size: 24px; display: flex; align-items: center; justify-content: center }
.step b { display: block; font-size: 32px; color: #134e4a }
.step span { display: block; font-size: 22px; color: #64748b; line-height: 1.4; margin-top: 8px }
.arrow { padding-top: 40px }
.example { margin-top: 40px; display: flex; gap: 22px; align-items: flex-start; background: #fffbeb; border: 2px solid #fde68a; border-radius: 26px; padding: 22px 30px; font-size: 25px; line-height: 1.6; color: #44403c }
.example .ur { font-size: 24px; color: #0f766e }
/* grid cards */
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px }
.card.f { padding: 24px 30px }
.fi { width: 64px; height: 64px; border-radius: 20px; background: #f0fdfa; display: flex; align-items: center; justify-content: center; margin-bottom: 12px }
.fi.amber { background: #fffbeb }
.card.f b { display: block; font-size: 28px; color: #134e4a }
.card.f span { display: block; font-size: 22px; color: #64748b; line-height: 1.4; margin-top: 8px }
.tech .card.f { padding: 24px 30px }
.adminbar, .disc { margin-top: 22px; display: flex; gap: 16px; align-items: center; font-size: 25px; color: #334155; background: #f0fdfa; border: 2px solid #99f6e4; border-radius: 22px; padding: 14px 26px }
/* sos */
.sos { background: radial-gradient(1000px 700px at 100% 0%, #ffe4e6 0%, rgba(255,228,230,0) 60%), radial-gradient(900px 600px at 0% 100%, #fef3c7 0%, rgba(254,243,199,0) 60%), #ffffff }
.sos h2 { color: #881337 }
.sosvis { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 660px }
.sosbtn { position: relative; width: 320px; height: 320px; border-radius: 50%; background: linear-gradient(145deg, #f43f5e, #dc2626); display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; font-weight: 900; font-size: 64px; letter-spacing: .12em; box-shadow: 0 30px 80px rgba(220,38,38,.35) }
.soscap { margin-top: 120px; font-size: 30px; font-weight: 700; color: #be123c; background: #fff1f2; border: 2px solid #fecdd3; padding: 14px 30px; border-radius: 999px }
/* chips & sdgs */
.chips { display: flex; flex-wrap: wrap; gap: 14px; margin-top: -8px }
.chip { display: inline-flex; align-items: center; gap: 12px; background: #fff; border: 3px solid var(--c); border-radius: 999px; padding: 6px 20px 6px 6px; font-size: 23px; color: #1e293b }
.chip svg { background: var(--c); border-radius: 50%; padding: 7px; width: 42px; height: 42px }
.chip .ur { font-size: 22px; color: #64748b; line-height: 1 }
.sdgs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; margin-top: 28px }
.sdg { border-radius: 20px; color: #fff; padding: 16px 18px; height: 126px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 10px 26px rgba(15,23,42,.10) }
.sdgn { font-size: 46px; font-weight: 900; line-height: 1 }
.sdgt { font-size: 21px; font-weight: 700; line-height: 1.2 }
.note { font-size: 25px; color: #334155; margin-top: 22px; line-height: 1.5; max-width: 1600px }
`

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Awaaz — Team AVEZEA</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Noto+Nastaliq+Urdu:wght@400;700&display=block" rel="stylesheet">
<style>${css}</style></head><body>${slides.join('\n')}</body></html>`
writeFileSync(join(HERE, 'deck.html'), html)
console.log('deck.html written,', slides.length, 'slides')
// Render: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --no-pdf-header-footer
//   --run-all-compositor-stages-before-draw --virtual-time-budget=20000 --print-to-pdf=docs/pitch/Awaaz-AVEZEA.pdf file:///D:/GDG_HACKATHON/docs/pitch/deck.html
