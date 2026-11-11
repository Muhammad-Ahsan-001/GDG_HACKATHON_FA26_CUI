# Awaaz — build contract (single source of truth)

Every builder codes against THIS file. If you must deviate, keep the change minimal and
record it in the "Deviations" section at the bottom.

Project: Supabase ref `sossfezffxvargkzuyvc` (region ap-south-1), URL `https://sossfezffxvargkzuyvc.supabase.co`.
Repo root = Vite app (deployed to Vercel). Backend lives in `supabase/`.

## 0. Layout and ownership

```
/                       Vite + React 19 + TS 7 + Tailwind v4 PWA (root deployed to Vercel)
  vite.config.ts        (owner: PWA builder)
  vercel.json           (owner: PWA builder) SPA rewrites
  public/               icons, offline assets (owner: PWA builder)
  src/
    main.tsx App.tsx    (scaffold — routes already declared; builders only fill their pages)
    sw.ts               service worker: workbox precache + FCM background messages (owner: PWA builder)
    config.ts           frontend env access (scaffold)
    lib/
      supabase.ts       supabase-js client (scaffold)
      types.ts          shared DB/API types (scaffold — EXTEND, don't break)
      categories.ts     category colours + icons (scaffold)
      status.ts         status colours + icons (scaffold)
      i18n/             index.ts (scaffold) + one namespace file per area: common.ts (scaffold), map.ts, report.ts, auth.ts, dashboard.ts, pwa.ts
      api.ts            typed wrappers for every Edge Function + RPC (scaffold signatures; report builder fills bodies)
      push.ts           FCM token registration (owner: PWA builder)
      offlineQueue.ts   IndexedDB report queue (Phase 2)
      media.ts          image compression + storage upload (owner: report builder)
    hooks/              useAuth.tsx (scaffold), useClusters.ts (map builder), useRecorder.ts (report builder), useGeolocation.ts (scaffold)
    components/
      ui/               shared primitives (scaffold): Button, IconButton, Sheet, Badge, Spinner, AiLabel, CategoryIcon, StatusBadge
      map/              (owner: map builder)
      report/           (owner: report builder)
      dashboard/        (owner: dashboard builder)
    pages/              Landing, Login, Onboarding, MapPage, PinPage, MePage, ReportPage, Dashboard, OrgRegister, Admin
  supabase/
    config.toml
    migrations/         (owner: DB builder)
    functions/
      _shared/          models.ts (THE one model-ID config file), config.ts (thresholds), cors.ts, http.ts,
                        supabase.ts, openai.ts, gemini.ts, ai.ts, geocode.ts, fcm.ts, verify.ts, route.ts, notify.ts, types.ts
      process-report/ verify-report/ route-report/ notify-nearby/ vote/ assignment-action/ tts/ digest/
  scripts/              seed.mjs, demo-e2e.mjs, gen-demo-media.mjs (Node 24, ESM, no TS)
  docs/
```

## 1. Database (schema `public`, RLS ON for every table)

Extensions (schema `extensions`): `postgis`, `vector`, `pgcrypto` (gen_random_uuid is core).
All geo columns are `extensions.geography(Point|Polygon,4326)`. Embedding dim = **1536**
(`text-embedding-3-large` with dimensions=1536; Gemini fallback would use `gemini-embedding-001` with outputDimensionality 1536 —
vectors from different models are never compared: match on `embedding_model`).

### Enums
- `user_role`: `citizen | ngo | responder | admin`
- `org_type`: `shelter | food_bank | health_ngo | rescue_1122 | fire | police | water`
  (ngo role owns shelter/food_bank/health_ngo; responder role owns rescue_1122/fire/police/water)
- `report_category`: `hazard | fire | flood | water | food | health | safety | other`
- `urgency_level`: `low | medium | high | critical`
- `report_status`: `unconfirmed | verified | disputed | in_progress | resolved`
- `vote_type`: `confirm | dispute`
- `assignment_status`: `alerted | claimed | in_progress | resolved`
- `media_type`: `audio | image`

### Tables
```
profiles(
  id uuid pk -> auth.users(id) on delete cascade,
  role user_role not null default 'citizen',
  display_name text, phone text,
  language text not null default 'ur' check (language in ('ur','en')),
  trust_score real not null default 0.5,           -- 0..1
  last_location geography(Point,4326), last_location_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz default now(), updated_at timestamptz default now())
  -- trigger on auth.users insert creates the profile; role from raw_user_meta_data->>'role'
  --   only if in (citizen,ngo,responder) else citizen. NEVER admin from signup.
  -- users may update display_name, phone, language, last_location(_at) of their own row only;
  --   role / trust_score / is_demo are protected by a BEFORE UPDATE trigger unless current_user is service role/postgres.

organizations(
  id uuid pk default gen_random_uuid(), owner_id uuid not null -> profiles(id),
  name text not null, org_type org_type not null,
  categories report_category[] not null default '{}',
  center geography(Point,4326) not null, radius_m integer,              -- centre + radius form
  service_area geography(Polygon,4326) not null,                        -- always filled (buffer of centre if radius form)
  phone text, approved boolean not null default false,
  created_at timestamptz default now())

clusters(
  id uuid pk default gen_random_uuid(),
  category report_category not null, urgency urgency_level not null default 'medium',
  centroid geography(Point,4326) not null,
  report_count int not null default 0, reporter_count int not null default 0,
  confirm_count int not null default 0, dispute_count int not null default 0,
  photo_match_count int not null default 0,
  confidence real not null default 0, ai_reason text,
  status report_status not null default 'unconfirmed',
  summary_en text, summary_ur text, title_en text, title_ur text,
  primary_report_id uuid,                -- first report (fk added after reports exists)
  photo_path text,                       -- first image (public bucket path) or null
  food_servings int, food_type text, safe_until timestamptz,
  claimed_org_id uuid -> organizations(id), claimed_org_name text,
  routed_at timestamptz, nearby_notified_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_report_at timestamptz default now())

reports(
  id uuid pk default gen_random_uuid(),
  reporter_id uuid not null -> profiles(id),
  client_id text not null,               -- idempotency key from the client; unique(reporter_id, client_id)
  cluster_id uuid -> clusters(id),       -- null when rejected as spam
  category report_category not null default 'other', urgency urgency_level not null default 'medium',
  title_en text, title_ur text, summary_ur text, summary_en text, canonical_en text,
  transcript text, language text,        -- detected: ur | pa | en | mixed
  input_modes text[] not null default '{}',  -- subset of {voice,photo,text}
  embedding vector(1536), embedding_model text,
  location geography(Point,4326) not null, location_source text,  -- gps | map | geocoded | fallback
  address_text text, location_hints text[],
  status report_status not null default 'unconfirmed',
  confidence real not null default 0, ai_reason text,
  is_spam boolean not null default false, spam_reason text,
  photo_check jsonb,                     -- {matches_claim:bool, severity:'low'..'critical', notes, food_type, servings_estimate}
  extraction jsonb,                      -- raw AI extraction output
  ai_provider text,                      -- 'openai' | 'gemini' (who produced extraction)
  food_servings int, food_type text, safe_until timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now())
  -- HNSW index on embedding vector_cosine_ops; GIST on location; btree (category, created_at)

report_media(id uuid pk, report_id uuid -> reports on delete cascade, type media_type, storage_path text not null,
             bucket text not null, created_at)
report_votes(id uuid pk, report_id uuid -> reports, cluster_id uuid -> clusters, user_id uuid -> profiles,
             vote vote_type not null, created_at, unique(report_id, user_id))
             -- report_id = the cluster's primary report (UI votes on a pin = cluster)
assignments(id uuid pk, cluster_id uuid -> clusters, report_id uuid -> reports, org_id uuid -> organizations,
            status assignment_status not null default 'alerted', distance_m real, note text,
            alerted_at timestamptz default now(), claimed_at, claimed_by uuid, in_progress_at, resolved_at,
            unique(cluster_id, org_id))
device_tokens(id uuid pk, user_id uuid -> profiles on delete cascade, fcm_token text unique not null,
              user_agent text, created_at, last_seen_at)
notifications(id uuid pk, user_id uuid -> profiles on delete cascade, report_id uuid, cluster_id uuid,
              type text not null,  -- new_assignment | status_change | nearby_alert | food_alert | verified
              title_en text, title_ur text, body_en text, body_ur text, data jsonb, read_at timestamptz, created_at)
```

### RLS summary
- `profiles`: select own; admin selects all; update own (protected cols via trigger). Org lookups use views/RPCs.
- `organizations`: select where approved OR owner OR admin; insert via RPC only; update by admin (approve) via RPC.
- `clusters`: select for `anon, authenticated` (no identities inside). No direct writes (service role only).
- `reports`: select own (`reporter_id = auth.uid()`), or admin, or member of an org that has an assignment for the report's cluster. No direct client writes (Edge Functions use service role).
- `report_media`: select if you can select the report. Insert/update: none (service role).
- `report_votes`: select own; writes via RPC `cast_vote` only.
- `assignments`: select if org owner (`org_id in my_org_ids()`) or admin; updates via RPC only.
- `device_tokens`: full CRUD on own rows.
- `notifications`: select own; update own (read_at only).

### Views (security_invoker = false, owned by postgres; never expose reporter_id)
- `map_pins`: one row per cluster, excludes clusters resolved > 24 h ago.
  Columns: `id, category, urgency, status, lat, lng (float8), report_count, reporter_count, confirm_count,
  dispute_count, confidence, ai_reason, title_en, title_ur, summary_en, summary_ur, photo_url (full public URL or null),
  food_servings, food_type, safe_until, claimed_org_name, created_at, updated_at, last_report_at`.
- `public_reports`: `id, cluster_id, category, urgency, status, title_en, title_ur, summary_en, summary_ur, language,
  input_modes, has_photo, photo_url, created_at, is_mine (reporter_id = auth.uid())` — excludes spam.
- `org_directory`: approved orgs `id, name, org_type, categories, lat, lng, radius_m` (+ unapproved for owner/admin).
- `my_assignments`: assignments joined with cluster pin fields for orgs owned by auth.uid():
  `assignment_id, org_id, org_name, org_type, status, distance_m, note, alerted_at, claimed_at, in_progress_at, resolved_at,
   cluster_id, category, urgency, cluster_status, lat, lng, report_count, confidence, ai_reason, title_en, title_ur,
   summary_en, summary_ur, photo_url, food_servings, food_type, safe_until`.
  (Implemented as a security-definer function `get_my_assignments()` + view wrapper, or view with where on owner.)

### SQL functions (RPC)  — all `security definer`, `set search_path = public, extensions`
- `match_cluster(p_category report_category, p_lat float8, p_lng float8, p_embedding vector(1536), p_embedding_model text,
   p_radius_m float8 default 300, p_hours float8 default 6, p_limit int default 5)`
   returns table(cluster_id uuid, report_id uuid, similarity float8, distance_m float8)
   — same category, non-spam reports with non-null embedding of same model, created within p_hours, ST_DWithin radius,
   cluster status <> 'resolved'; ordered by similarity desc (similarity = 1 - (embedding <=> p_embedding)).
   NO threshold inside SQL — the Edge Function applies thresholds from config.
- `recompute_cluster(p_cluster_id uuid)` returns clusters — recomputes report_count, reporter_count (distinct reporter_id),
   confirm_count/dispute_count (distinct users across the cluster's votes), photo_match_count, centroid
   (ST_Centroid of report points), urgency = max, title/summary from primary report if null, photo_path, food fields, updated_at.
- `find_responders(p_lat float8, p_lng float8, p_category report_category, p_limit int default 5)`
   returns table(org_id uuid, org_name text, org_type org_type, owner_id uuid, distance_m float8)
   — approved orgs whose service_area ST_Covers the point and p_category = any(categories), nearest (to center) first.
- `nearby_citizen_tokens(p_lat float8, p_lng float8, p_radius_m float8 default 1000, p_exclude uuid[] default '{}')`
   returns table(user_id uuid, fcm_token text, language text) — citizens with last_location within radius and last_location_at > now()-48h.
- `cast_vote(p_cluster_id uuid, p_vote vote_type)` returns json {confirm_count, dispute_count}
   — auth required; raises 'own_report' if caller has a report in the cluster; upserts against primary report; recompute.
- `set_my_role(p_role user_role)` — caller only; refuses 'admin'; refuses change if caller is admin.
- `update_my_location(p_lat float8, p_lng float8)`.
- `register_organization(p_name text, p_org_type org_type, p_categories report_category[], p_lat float8, p_lng float8,
   p_radius_m int, p_phone text default null, p_polygon_geojson json default null)` returns uuid
   — owner = auth.uid(); validates role↔org_type (ngo: shelter/food_bank/health_ngo; responder: the rest); approved=false.
- `approve_organization(p_org_id uuid, p_approved boolean)` — admin only.
- `apply_assignment_action(p_assignment_id uuid, p_action text)` returns json
   — caller must own the org; 'claim' (alerted→claimed, sets cluster.claimed_org_*), 'start' (→in_progress, cluster+reports
   status in_progress), 'resolve' (→resolved, cluster+reports resolved). Returns {assignment_id, status, cluster_id,
   cluster_status, reporter_ids uuid[]} (reporter_ids used by the Edge Function to notify).
- `dashboard_stats(p_org_id uuid default null)` returns json {open, claimed, in_progress, resolved_today, avg_minutes_to_claim, by_category:{...}}.
- helpers: `is_admin() bool`, `my_org_ids() uuid[]`, `my_role() user_role`.

### Storage buckets
- `report-audio` (private). Client uploads to `{auth.uid()}/{uuid}.{ext}`; insert policy: authenticated, first path segment = auth.uid().
- `report-images` (public read). Client uploads to `{uuid}/{n}.jpg` (no uid in path!); insert: authenticated; max 5 MB; image/*.
- `tts-cache` (public read). Written only by service role: `{sha256}.mp3`.

### Realtime
Publication `supabase_realtime` includes `clusters, assignments, notifications, reports` (REPLICA IDENTITY FULL on clusters
and assignments). Clients: map subscribes to `clusters` (*), dashboard to `assignments`, everyone to own `notifications`,
citizen "Me" page to own `reports`. After a cluster change event, the client refetches that row from `map_pins`.

## 2. Edge Functions (Deno, `Deno.serve`, CORS on every response, JSON in/out)

All callers send `Authorization: Bearer <user access token>` (anonymous users have one too) and `apikey: <anon key>`.
Internal-only endpoints (`verify-report`, `route-report`, `notify-nearby`) also accept the service role key, and
are normally executed **inline** by importing `_shared/verify.ts`, `_shared/route.ts`, `_shared/notify.ts`
(no function-to-function HTTP hop in the hot path).
Errors: HTTP 4xx/5xx with `{error: string, code?: string}`.

### `_shared/ai.ts` — the ONLY module other code uses for AI
**User decision (2026-11-11): OpenAI (paid) does EVERY AI task, including digest. Gemini is NOT called at all for now.**
`models.ts` lists, per task, an OpenAI `primary` model, an OpenAI `fallback` model (used automatically when the primary
call fails / times out / 5xx / 429), and a `gemini` fallback model ID that is documented but NOT wired — do not write
Gemini request code; leave a single clearly-marked `// GEMINI_FALLBACK_HOOK` comment where it would plug in.
`AiMeta.provider` is therefore always `'openai'` for now (type keeps `'gemini'` for later).
```ts
export type Provider = 'openai' | 'gemini'
export interface AiMeta { provider: Provider; model: string; fallback: boolean; ms: number }
transcribe(audio: Uint8Array, mime: string, hintLang?: 'ur'|'en'|'pa'|'auto'): Promise<{ text: string; language: string; meta: AiMeta }>
extractReport(input: { text?: string; transcript?: string; uiLanguage: 'ur'|'en'; addressText?: string; categoryHint?: string })
  : Promise<{ data: Extraction; meta: AiMeta }>
checkPhoto(input: { imageUrls: string[] /* https or data: */; claim: Extraction }): Promise<{ data: PhotoCheck; meta: AiMeta }>
embed(text: string): Promise<{ vector: number[]; model: string; meta: AiMeta }>   // 1536 dims
sameIncident(a: string, b: string): Promise<{ same: boolean; reason: string; meta: AiMeta }>  // gray-zone adjudication
scoreVerification(input: VerificationInput): Promise<{ confidence: number; reason_en: string; reason_ur: string; meta: AiMeta }>
speak(text: string, lang: 'ur'|'en'): Promise<{ audio: Uint8Array; mime: 'audio/mpeg'; model: string; voice: string }>
digest(input: { pins: DigestPin[]; mode: 'nearby'|'daily'; orgName?: string }): Promise<{ en: string; ur: string; meta: AiMeta }> // OpenAI (cheap model)

interface Extraction {
  category: 'hazard'|'fire'|'flood'|'water'|'food'|'health'|'safety'|'other'
  urgency: 'low'|'medium'|'high'|'critical'
  title_en: string; title_ur: string           // <= 8 words
  summary_en: string; summary_ur: string       // 1-2 sentences
  canonical_en: string                          // normalised "<issue> at/near <landmark>, <area>" lowercase, for embeddings
  location_hints: string[]                      // e.g. ["Street 5", "school", "G-9/4", "Islamabad"]
  language: 'ur'|'pa'|'en'|'mixed'
  is_spam: boolean; spam_reason: string | null  // spam, joke, abuse or not a local civic issue
  food: { food_type: string; servings_estimate: number; safe_hours: number } | null
  confidence_notes: string
}
interface PhotoCheck { matches_claim: boolean; severity: 'low'|'medium'|'high'|'critical'; notes: string;
                       food_type: string | null; servings_estimate: number | null }
interface VerificationInput { category: string; urgency: string; reports: { summary_en: string; minutes_ago: number;
  distance_m: number; reporter_trust: number; has_photo: boolean; photo_matches: boolean | null; modes: string[] }[];
  independent_reporters: number; confirms: number; disputes: number; heuristic: number }
interface DigestPin { category: string; urgency: string; status: string; title_en: string; report_count: number; minutes_ago: number; distance_m?: number }
```
Every model ID lives in `_shared/models.ts`; every threshold in `_shared/config.ts`:
`DUP_RADIUS_M=300, DUP_WINDOW_HOURS=6, DUP_SIM_THRESHOLD=0.85, DUP_GRAY_ZONE_MIN=0.72, VERIFY_THRESHOLD=0.7,
 NEARBY_RADIUS_M=1000, ROUTE_MAX_ORGS=3, FOOD_DEFAULT_SAFE_HOURS=4`.

### Verification rule (`_shared/verify.ts`, deterministic guard rails around the AI score)
```
heuristic = clamp( 0.35
  + 0.25 * min(independent_reporters - 1, 2)   // 2 reporters -> 0.60, 3+ -> 0.85
  + 0.10 * min(confirms, 3) - 0.15 * min(disputes, 3)
  + 0.10 * (any photo matches claim) - 0.10 * (photo contradicts claim)
  + 0.05 * (avg reporter trust - 0.5) * 2, 0, 1)
  + 0.15 bonus if independent_reporters >= 2 and modes differ (voice vs text) or a photo matches  (cap 1)
ai = scoreVerification(...)  → final = clamp(ai.confidence, heuristic - 0.15, heuristic + 0.15)
status: disputes > confirms + (independent_reporters - 1)  → 'disputed'
        else final >= 0.7 → 'verified' else 'unconfirmed'
        (never downgrade in_progress/resolved; a single report with no votes stays 'unconfirmed')
```
The 2-reporter demo (voice + text of the same issue) must deterministically land ≥ 0.7.
On any transition, update `clusters.status/confidence/ai_reason` and all the cluster's `reports.status/confidence/ai_reason`.

### `process-report` POST
```ts
req: { client_id: string; text?: string; audio_path?: string /* report-audio bucket */; image_paths?: string[] /* report-images */;
       lat?: number; lng?: number; accuracy_m?: number; location_source?: 'gps'|'map'|'geocoded';
       address_text?: string; language?: 'ur'|'en'|'pa'|'auto'; ui_language: 'ur'|'en'; category_hint?: string }
res: { report_id: string; cluster_id: string | null; is_duplicate: boolean; similarity: number | null;
       status: ReportStatus; confidence: number; category: Category; urgency: Urgency;
       title_en: string; title_ur: string; summary_en: string; summary_ur: string; ai_reason: string | null;
       routed: { org_name: string; org_type: string; distance_m: number }[]; ai_provider: 'openai'|'gemini';
       transcript?: string; food?: { servings: number; safe_until: string; food_type: string } | null;
       rejected?: { reason: string; message_en: string; message_ur: string };
       needs_location?: { hints: string[] } }   // 422 when no GPS/map point AND geocoding failed
```
Pipeline: idempotency check (reporter_id, client_id) → download audio → transcribe → extract (+ checkPhoto in parallel
when images) → location: client lat/lng, else geocode `address_text` / `location_hints` (Google server key if set, else
Nominatim, biased to Islamabad/Rawalpindi) → embed(canonical_en) → match_cluster → attach if sim ≥ 0.85, or if
0.72 ≤ sim < 0.85 and sameIncident() says yes → else new cluster → insert report + media rows → recompute_cluster →
verify (inline) → route (inline) if (verified OR urgency in high/critical) and not yet routed for that org →
notify-nearby (inline) if verified and urgency high/critical and not yet notified. Food: safe_until = now + safe_hours
(photo servings estimate preferred over text). Spam → report stored with is_spam=true, no cluster, `rejected` returned.

### `vote` POST `{cluster_id, vote: 'confirm'|'dispute'}` → `{status, confidence, confirm_count, dispute_count, ai_reason}`
Calls RPC `cast_vote` AS THE USER (user-scoped client), then inline verify (+route/notify when it flips to verified).

### `assignment-action` POST `{assignment_id, action: 'claim'|'start'|'resolve', note?}` → `{assignment_id, status, cluster_status}`
Calls RPC `apply_assignment_action` as the user; then inserts `notifications` (type status_change) for each reporter and
pushes FCM to their tokens (bilingual title/body), and for 'claim' notifies the other alerted orgs.

### `verify-report` POST `{cluster_id}` → `{cluster_id, status, confidence, reason, provider}`
### `route-report` POST `{cluster_id}` → `{assignments: {org_id, org_name, distance_m, pushed: number}[]}`
  Creates `assignments` (upsert on cluster_id+org_id), `notifications` (new_assignment / food_alert) for org owners, FCM push
  (HTTP v1, OAuth via service-account JWT; delete tokens on 404/UNREGISTERED). Sets clusters.routed_at.
### `notify-nearby` POST `{cluster_id}` → `{notified: number}` (citizens within 1 km, excluding the cluster's reporters)
### `tts` POST `{text, lang: 'ur'|'en'}` → `{url, cached}` (sha256(model|voice|lang|text) → `tts-cache/{hash}.mp3`)
### `digest` POST `{mode: 'nearby', lat, lng, radius_m?}` | `{mode: 'daily', org_id?}` → `{en, ur, provider, generated_at, pin_count}`

FCM message shape (data-only + webpush.notification so it shows even when backgrounded):
`{ message: { token, notification: {title, body}, data: {type, cluster_id, url}, webpush: { fcm_options: { link: <APP_URL + url> },
  notification: { icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: cluster_id, renotify: true } } } }`
Server secret names: `OPENAI_API_KEY, GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT_JSON (whole JSON as string),
GOOGLE_GEOCODING_SERVER_KEY (optional), APP_URL`. `SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

## 3. Frontend

Routes (react-router v7, lazy pages): `/` Landing · `/login` · `/onboarding` (role pick) · `/map` (citizen home, default after
login) · `/report` (report sheet over map) · `/pin/:id` (pin sheet over map) · `/me` · `/dashboard` (ngo/responder) ·
`/org/register` · `/admin`.
- Auth: email+password; one-tap **anonymous** "Start reporting" (citizen); quick "Demo as …" buttons on /login that
  sign in with the seeded demo accounts (see `src/lib/demoAccounts.ts`).
- Map: `@vis.gl/react-google-maps` `APIProvider` + `Map` (mapId from env, fallback `DEMO_MAP_ID`), one `AdvancedMarker`
  per cluster with category colour + lucide icon + status ring + count bubble. Centre default Islamabad (33.6844, 73.0479), zoom 12.
- Big mic FAB (≥ 72 px) is the primary action on /map. Photo and keyboard buttons beside it (≥ 56 px).
- Every AI output shows the `AiLabel` chip ("AI-assessed" / "AI جائزہ").
- i18n: `useI18n()` → `{ t(key), lang, setLang, dir }`; `<html dir>` switches to `rtl` for Urdu; Urdu font Noto Nastaliq Urdu.
- Category colours/icons from `src/lib/categories.ts`; status from `src/lib/status.ts` — never hard-code elsewhere.

## Deviations
(append here: who, what, why)
- lead: `_shared/cors.ts` merged into `_shared/http.ts` (exports corsHeaders, json, errorResponse, readJson, serve, HttpError, background).
  `_shared/supabase.ts` (adminClient, userClient, isServiceRequest, requireUser, requireServiceOrUser) and `_shared/models.ts`,
  `_shared/config.ts`, `_shared/types.ts` are written by the lead — import them, don't rewrite them.
- lead: embeddings = `text-embedding-3-large` with `dimensions: 1536`. Extraction/reasoning = `gpt-6-luna` (Responses API,
  reasoning.effort "low", NO temperature), vision = `gpt-6.1-terra`, STT = `gpt-transcribe` (languages[]), TTS = `gpt-4o-mini-tts`.
- lead: frontend shared header = `src/components/layout/AppHeader.tsx` (`<AppHeader floating? right? />`).
- lead: demo accounts list = `src/lib/demoAccounts.ts` (password constant DEMO_PASSWORD).
