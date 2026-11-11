# Supabase platform specifics, as of 2026-11-11 (research report for "Awaaz")

**How this was checked:**
- I parsed the live Management API OpenAPI spec (`https://api.supabase.com/api/v1-json`). A local copy is at `C:\Users\HP\AppData\Local\Temp\claude\cd27548ea9a041b3\c52886cc-1d31-4320-b022-4aa3083e901d\scratchpad\sb\v1.json`.
- I read the raw markdown of the official docs (`https://supabase.com/docs/guides/<page>.md`).
- I read the npm registry, GitHub source (supabase/cli, supabase/supabase-js, supabase/server, supabase/edge-runtime) and the `--help` output of the installed CLI v2.118.0.
- I ran `supabase init` and `supabase functions new` in a scratch folder: `C:\Users\HP\AppData\Local\Temp\claude\cd27548ea9a041b3\c52886cc-1d31-4320-b022-4aa3083e901d\scratchpad\initprobe`.

**What I did not do:** I made no calls against a live project. Nothing was created, paused or changed.

---

## 0. Changes since older guides that will bite you

1. **New tables in `public` are no longer exposed to the Data API automatically.**
   - Dates: the new behaviour became the default for new projects on 2026-05-30, and was applied to all existing projects on 2026-10-30.
   - Without explicit `GRANT`s, PostgREST and supabase-js return `permission denied` (SQLSTATE 42501).
   - Postgres Changes in Realtime also needs `SELECT` granted to the subscribing role. The Realtime quickstart now starts with `GRANT SELECT ON public.todos TO anon;`.
   - Sequences (for `serial` columns) and views need their own grants.
   - Recommended SQL, per table:
     ```sql
     grant select on public.t to anon;
     grant select, insert, update, delete on public.t to authenticated;
     grant select, insert, update, delete on public.t to service_role;
     alter table public.t enable row level security;
     ```
   - Supabase staff also say: "Sequences and functions don't inherit table grants, so include them explicitly." Their suggestion for functions is `grant execute on all functions in schema public to anon, authenticated, service_role;`.
   - **The local stack differs from the cloud.** The CLI v2.118 `config.toml` template has `# auto_expose_new_tables = true` under `[api]`, and the template says that when unset it falls back to `true`. So migrations that work locally can fail with 42501 on the cloud project. Always write the GRANTs in your migrations.
   - Sources: https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically and https://github.com/orgs/supabase/discussions/45329

2. **Legacy `anon` / `service_role` JWT keys** — "Supabase is deprecating the `anon` and `service_role` keys by the end of 2026."
   - Supabase's own timeline (GitHub discussion #29260, last updated June 2025):
     - "New projects no longer have `anon` and `service_role` available for use."
     - "Projects restored from 1st November 2025 will no longer be restored with the legacy API keys."
     - Late 2026 (TBC): legacy keys are deleted.
   - So a pause and restore can drop your legacy keys. Build only on `sb_publishable_…` / `sb_secret_…`.
   - Sources: https://supabase.com/docs/guides/getting-started/api-keys and https://github.com/orgs/supabase/discussions/29260

3. **Supabase CLI v3.0.0 was released 2026-11-02 (latest is 3.1.0).** You have v2.118.0, which still works. Do not upgrade mid-hackathon. v3 breaking changes:
   - `db push` and related commands target the **local** stack by default, so you must add `--remote`.
   - Every change to a hosted project needs `--yes` when run non-interactively. A `y` piped on stdin no longer counts.
   - `link --password` is ignored.
   - An `import_map.json` inside a function directory is no longer accepted.
   - Current docs already show v3 syntax (`--remote`), so translate to v2: `--linked` or `--project-ref`.
   - Source: `gh api repos/supabase/cli/releases/tags/v3.0.0`, and https://supabase.com/docs/guides/local-development/cli/migrating-to-v3

4. **The new `@supabase/server` SDK (`npm:@supabase/server@1`, latest 1.9.2 from 2026-10-12)** is now the documented way to authenticate Edge Function callers. CLI v2.118 `functions new` scaffolds use it.
   - `auth: 'user'` **rejects legacy HS256 user JWTs**, because it requires a `kid`. Your project must use JWT signing keys, i.e. asymmetric keys, which is the default for new projects.
   - Source: https://github.com/supabase/server/blob/main/docs/auth-modes.md, section "Legacy keys and JWTs are not supported".

5. **Anonymous sign-ins are limited to 30 per hour per IP by default.** At a hackathon venue behind one NAT IP this will run out. Raise `rate_limit_anonymous_users`.
   - Source: https://supabase.com/docs/guides/auth/rate-limits

---

## 1. Management API (`https://api.supabase.com/v1`)

**Auth:** send `Authorization: Bearer <token>`.
- The token is a personal access token: `sbp_…`, or `sbp_fc…` for a scoped token.
- Create one at https://supabase.com/dashboard/account/tokens. OAuth tokens also work.

**Rate limit:** 120 requests per minute, counted per user, per project or org, and per endpoint.
- Over the limit you get 429. Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- Source: https://supabase.com/docs/reference/api/introduction

**Project ref:** exactly 20 characters matching `^[a-z]+$` (from the spec).

### 1.1 Pause, restore and status (from the OpenAPI spec)

| Purpose | Method and path | Body | Response | Scope |
|---|---|---|---|---|
| Pause | `POST /v1/projects/{ref}/pause` | none | 200, no body defined | `projects:write` (FGA `project_admin_write`) |
| Restore (unpause) | `POST /v1/projects/{ref}/restore` | none | 200, no body | `projects:write` |
| Cancel a restore | `POST /v1/projects/{ref}/restore/cancel` | none | — | — |
| List restore versions | `GET /v1/projects/{ref}/restore` | — | `{available_versions:[{version, release_channel, postgres_engine}]}` | `projects:read` |
| Status | `GET /v1/projects/{ref}` | — | `{id, ref, organization_id, organization_slug, name, region, created_at, status, database}` | — |
| Service health | `GET /v1/projects/{ref}/health` | — | — | — |

- `status` is one of: `INACTIVE` (paused), `ACTIVE_HEALTHY`, `ACTIVE_UNHEALTHY`, `COMING_UP`, `UNKNOWN`, `GOING_DOWN`, `INIT_FAILED`, `REMOVED`, `RESTORING`, `UPGRADING`, `PAUSING`, `RESTORE_FAILED`, `RESTARTING`, `PAUSE_FAILED`, `RESIZING`, `PROMOTING`.
- Only Free-plan projects can be paused. Paid projects "cannot be paused".
- A paused project can be restored for up to 1 year.
- "Paused projects do not count towards your free project limit" (the Free plan allows 2 projects).
- Sources: https://supabase.com/docs/guides/platform/project-pausing and https://supabase.com/docs/guides/platform/billing-on-supabase
- A community report describes a project stuck in `PAUSING` for more than 30 minutes, so poll with a timeout.

### 1.2 API keys

- **`GET /v1/projects/{ref}/api-keys?reveal=true`** returns an array of `{api_key, id, type: "legacy"|"publishable"|"secret", prefix, name, description, hash, secret_jwt_template, inserted_at, updated_at}`.
  - Legacy keys appear with `type: "legacy"` and names `anon` / `service_role`.
  - New keys are named `default`.
  - `reveal=true` needs the `secrets:read` scope. For a scoped token it needs "API Keys: Read" plus "API Key Secrets: Read", otherwise 403.
- **`POST /v1/projects/{ref}/api-keys`** with body `{"type":"publishable"|"secret","name":"^[a-z_][a-z0-9_]+$" (4–64 chars),"description":…}` creates a key.
- **`GET /v1/projects/{ref}/api-keys/legacy`** returns `{enabled:bool}`. **`PUT …/legacy?enabled=false`** disables legacy keys. Both endpoints are described as "will be removed in the future, check for HTTP 404".
- CLI v2.118: `supabase projects api-keys --project-ref <ref> [--reveal]`.
- Sources: OpenAPI spec, and https://supabase.com/docs/guides/getting-started/api-keys#find-your-keys

**Recommendation and status of the key types:**
- Publishable key (`sb_publishable_…`): use in the browser. It maps to the `anon` / `authenticated` roles.
- Secret key (`sb_secret_…`): backend only. It maps to `service_role` (BYPASSRLS).
  - It returns 401 when used from a browser; this is detected from the `User-Agent` header.
- Neither is a JWT. Send them in the `apikey` header, not `Authorization: Bearer`.
- Sources: https://supabase.com/docs/guides/getting-started/api-keys and https://supabase.com/docs/guides/functions/auth-headers

**Do legacy keys still work for a project created in late 2026?**
- Supabase's timeline says new projects no longer get them.
- Current docs only say "Older projects don't have these [new] keys yet", which implies new projects get only the new keys.
- **Unverified:** I could not confirm it against a freshly created project. Check with `GET …/api-keys/legacy`.

**Env vars injected into Edge Functions** (https://supabase.com/docs/guides/functions/secrets):
- `SUPABASE_URL`
- `SUPABASE_DB_URL`
- `SUPABASE_PUBLISHABLE_KEYS`: a JSON dictionary, e.g. `{"default":"sb_publishable_…"}`
- `SUPABASE_SECRET_KEYS`: a JSON dictionary
- `SUPABASE_JWKS`
- Legacy: `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` "still exist in the runtime, but they carry the legacy keys". My inference: they are empty or invalid when the project has no legacy keys.
- Hosted only: `SB_REGION`, `SB_EXECUTION_ID`, `DENO_DEPLOYMENT_ID`.
- Read the secret key with:
  ```ts
  const secretKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']
  ```

### 1.3 Auth config

**`PATCH /v1/projects/{ref}/config/auth`** (scope `auth:write`). Every field is optional and nullable. The response is 200 with the full `AuthConfigResponse`. Fields confirmed in the spec:

| Field | Type and notes | `config.toml` equivalent |
|---|---|---|
| `site_url` | string matching `^[^,]+$` | `[auth] site_url` |
| `uri_allow_list` | **comma-separated string**, e.g. `"http://localhost:5173/**,https://*-team.vercel.app/**"` | `additional_redirect_urls` (the CLI joins the list with commas) |
| `external_anonymous_users_enabled` | bool | `[auth] enable_anonymous_sign_ins` |
| `mailer_autoconfirm` | bool; `true` means no email confirmation | `[auth.email] enable_confirmations` (inverted) |
| `disable_signup` | bool | — |
| `external_email_enabled` | bool | — |
| `rate_limit_anonymous_users` | int ≥ 1 | — |
| `jwt_exp` | int, 0–604800 | — |
| `security_captcha_enabled`, `security_captcha_provider` | bool; provider is `"turnstile"` or `"hcaptcha"` | — |

- `GET` on the same path returns the current config.
- The field mappings were checked in CLI source `apps/cli/src/commands/config/push/push.encoders.ts` and in a recorded fixture where `uri_allow_list` is `"https://example.com/callback"`.
- Wildcards `*`, `**` and `?` are allowed in redirect URLs. For Vercel previews use `https://*-<team-or-account-slug>.vercel.app/**`.
- Anonymous users get the `authenticated` role and an `is_anonymous` JWT claim.
- Sources: https://supabase.com/docs/guides/auth/redirect-urls and https://supabase.com/docs/guides/auth/auth-anonymous

### 1.4 Storage buckets

**The Management API cannot create or update buckets.** It only has `GET /v1/projects/{ref}/storage/buckets`, which returns `[{id, name, owner, created_at, updated_at, public}]`. Other ways:
- **SQL in a migration** (recommended): `insert into storage.buckets (id, name, public) values ('media','media',false) on conflict (id) do nothing;`
  - The table also has `file_size_limit` and `allowed_mime_types` columns. **Unverified:** I took these names from the API body, not the table DDL.
- **Storage REST API**: `POST https://<ref>.supabase.co/storage/v1/bucket` with body `{id, name, public, file_size_limit, allowed_mime_types, type?}`. Update with `PUT /storage/v1/bucket/{id}`.
  - Body shape is from storage-js source, `packages/core/storage-js/src/packages/StorageBucketApi.ts`.
  - Easiest from code: `supabase.storage.createBucket('media', {public:false, allowedMimeTypes:['image/*','audio/*'], fileSizeLimit:'10MB'})` with a client created from the secret key.
- **`config.toml`**: a `[storage.buckets.<name>]` section with `public`, `file_size_limit = "50MiB"`, `allowed_mime_types`, `objects_path`, then `supabase seed buckets --project-ref <ref>`.
- Uploads are denied until you add RLS policies on `storage.objects`. The storage schemas are not affected by the GRANTs change.
- Sources: https://supabase.com/docs/guides/storage/buckets/creating-buckets and https://supabase.com/docs/guides/storage/security/access-control

### 1.5 Edge Function secrets

| Purpose | Method and path | Body | Response | Scope |
|---|---|---|---|---|
| Set (bulk, max 100) | `POST /v1/projects/{ref}/secrets` | `[{"name":"GEMINI_API_KEY","value":"…"}]` | 201 | `secrets:write` |
| List | `GET /v1/projects/{ref}/secrets` | — | `[{name, value (digest), updated_at}]` | — |
| Delete | `DELETE /v1/projects/{ref}/secrets` | `["NAME"]` | — | — |

- Names must not start with `SUPABASE_`.
- Limits: 100 secrets, 256-character names, 24,576-character values.
- CLI: `supabase secrets set --env-file .env` or `supabase secrets set K=V`.
- Source: https://supabase.com/docs/guides/functions/limits

### 1.6 Useful extras

- **Run SQL:** `POST /v1/projects/{ref}/database/query` with body `{"query":"…","parameters":[],"read_only":false}`. Returns 201; the response shape is not in the spec (in practice an array of rows, unverified).
- **Available regions:** `GET /v1/projects/available-regions?organization_slug=<slug>`.
- **Create a project:** `POST /v1/projects` with body `{name, db_pass, organization_slug, region_selection:{type:"specific",code:"ap-south-1"}, desired_instance_size?}`.
  - `organization_id` and `region` are deprecated.
  - Leaving out `desired_instance_size` gives the smallest size.
- **Deploy a function without the CLI:** `POST /v1/projects/{ref}/functions/deploy?slug=…` as multipart, with `file[]` plus `metadata {entrypoint_path, import_map_path, verify_jwt, name, static_patterns}`.

### 1.7 Deno script example (run locally: `deno run --allow-env --allow-net mgmt.ts`)

```ts
const TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN")!;  // sbp_...
const REF = Deno.env.get("SUPABASE_PROJECT_REF")!;
async function mgmt(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.supabase.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const keys = await mgmt("GET", `/projects/${REF}/api-keys?reveal=true`);
const publishable = keys.find((k: any) => k.type === "publishable" && k.name === "default")?.api_key;
await mgmt("PATCH", `/projects/${REF}/config/auth`, {
  site_url: "https://awaaz.vercel.app",
  uri_allow_list: "http://localhost:5173/**,https://*-myteam.vercel.app/**",
  external_anonymous_users_enabled: true, mailer_autoconfirm: true, rate_limit_anonymous_users: 300,
});
await mgmt("POST", `/projects/${REF}/secrets`, [{ name: "GEMINI_API_KEY", value: Deno.env.get("GEMINI_API_KEY")! }]);
await mgmt("POST", `/projects/${REF}/database/query`, { query: "insert into storage.buckets (id,name,public) values ('media','media',false) on conflict (id) do nothing;" });
// pause / restore + poll
// await mgmt("POST", `/projects/${REF}/pause`);
// await mgmt("POST", `/projects/${REF}/restore`);
for (let i = 0; i < 60; i++) { const p = await mgmt("GET", `/projects/${REF}`); if (p.status === "ACTIVE_HEALTHY") break; await new Promise(r => setTimeout(r, 10_000)); }
```

---

## 2. Where the CLI stores its access token on Windows

**Windows Credential Manager entry** (checked on this machine with `cmdkey /list`):
- Generic credential, target `Supabase CLI:supabase`, user `supabase`.
- In general the target is `"Supabase CLI:" + <profile>`, and the default profile is `supabase`.
- The legacy entry is `Supabase CLI:access-token`.
- Database passwords saved by `link` are stored under `Supabase CLI:<project-ref>`.
- The token is stored as raw UTF-8 bytes and matches `^sbp_(oauth_|v0_)?[a-f0-9]{40}$`.
- Source: `apps/cli/src/auth/command-credentials.layer.ts`, which has `KEYRING_SERVICE = "Supabase CLI"` and `windowsCredentialTarget = \`${KEYRING_SERVICE}:${account}\``, and docs/adr/0008 in github.com/supabase/cli.

**Order the CLI looks for a token:**
1. `--token` (for `login`)
2. the `SUPABASE_ACCESS_TOKEN` env var
3. the keyring entry for the profile
4. the legacy keyring entry
5. the file `~/.supabase/access-token`

`SUPABASE_NO_KEYRING=1` forces the file fallback. `supabase logout` deletes the token and all project DB-password entries.

**For scripts:** create a PAT in the dashboard and export `SUPABASE_ACCESS_TOKEN`. This is simpler than reading the keyring, and the env var overrides the saved token.

**Not done:** I wrote a PowerShell `CredRead` snippet to read the keyring entry, but the permission classifier blocked running it, so it is untested. It is at `C:\Users\HP\AppData\Local\Temp\claude\cd27548ea9a041b3\c52886cc-1d31-4320-b022-4aa3083e901d\scratchpad\sb\readcred.ps1`.

---

## 3. Edge Functions (late 2026)

**Runtime:**
- Hosted runtime is "Deno 2.1 compatible" (all regions since 2025-08-15).
- The edge-runtime repo (v1.78.1, 2026-11-05) bundles `deno` crate **2.1.4**.
- Local `config.toml` template: `[edge_runtime] deno_version = 2`, `policy = "per_worker"`.
- Do not rely on Deno APIs newer than 2.1, even if your local `deno` is newer.
- Sources: https://supabase.com/changelog/37941-all-regions-now-run-deno-2-1-compatible-release, and `github.com/supabase/edge-runtime/deno/Cargo.toml`.

**Imports:**
- Use `npm:` and `jsr:` specifiers, plus `node:` built-ins.
- Give each function its own `deno.json` (recommended). Import maps are "legacy", and `deno.json` wins if both exist.
- What the v2.118 `supabase functions new x` scaffold actually wrote:
  - `supabase/functions/x/deno.json`: `{"imports":{"@supabase/functions-js":"jsr:@supabase/functions-js@^2","@supabase/server":"npm:@supabase/server@^1"}}`
  - `.npmrc`
  - `index.ts` using `export default { fetch: withSupabase({ auth: ["publishable","secret"] }, …) }`
  - In `config.toml`: `[functions.x] enabled=true, verify_jwt=false, import_map="./functions/x/deno.json", entrypoint="./functions/x/index.ts"`.
- `functions new --auth user` gives `verify_jwt = true` and `withSupabase({ auth: "user" })`. The flag accepts `none`, `apikey` or `user`.
- Source: https://supabase.com/docs/guides/functions/dependencies

**Handler:** `Deno.serve(handler)` and `export default { fetch }` are equivalent. Docs prefer `export default { fetch }`.

**Verifying callers with the new keys:**
- With `@supabase/server` (https://supabase.com/docs/guides/functions/auth):
  - `auth:'user'`: a user JWT on `Authorization`. `ctx.supabase` is scoped by RLS, plus `ctx.userClaims` and `ctx.jwtClaims`.
  - `auth:'secret'`: the `default` secret key on `apikey`. Gives `ctx.supabaseAdmin`. Requires `verify_jwt=false`.
  - `auth:'publishable'`, and `auth:'none'` for webhooks.
  - Arrays such as `['user','secret']` try each mode in turn. Named keys look like `'secret:billing'`, and `'secret:*'` accepts any secret key.
  - `createSupabaseContext(req,{auth})` lets you build your own 401 response.
- `verify_jwt` (the platform check) validates HS256 and asymmetric JWTs.
  - **Conflict in the docs:** one page says it also lets `sb_` keys through for compatibility, but that "doesn't authenticate the caller". The migration page says it "only understands the legacy JWT-based keys", and that a `Bearer sb_…` header gives `Invalid JWT`.
  - Safe rules: put `sb_` keys only in `apikey`, set `verify_jwt=false` for key-authenticated functions, and authorize in code.
- Without the SDK: `await supabase.auth.getClaims(jwt)` (auth-js). It verifies against the JWKS for asymmetric keys and falls back to `getUser()` for HS256.

**CORS:**
- `withSupabase` handles `OPTIONS` and CORS automatically.
- Manually: `import { corsHeaders } from 'npm:@supabase/supabase-js@^2/cors'` (needs v2.95.0 or later), and on `OPTIONS` return `Response.json({ok:true},{headers:corsHeaders})`.
- Hardcoded fallback:
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage`
  - `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`
- Source: https://supabase.com/docs/guides/functions/cors

**Deploy:**
- Command: `supabase functions deploy [name] [--use-api] [--no-verify-jwt] [--project-ref <ref>] [--prune] [-j N]`.
- `--use-api` bundles on the server, without Docker. The CLI falls back to it automatically when Docker isn't available.
- Server-side bundles are limited to **5 MB** (20 MB when bundled locally), and **static files can't be deployed with the API flag**.
- `verify_jwt` is read from `[functions.<name>]` in `config.toml`.
- Sources: https://supabase.com/docs/guides/functions/quickstart and https://supabase.com/docs/guides/functions/limits

**Limits** (https://supabase.com/docs/guides/functions/limits):
- 256 MB memory.
- Wall clock 150 s on Free, 400 s on paid.
- **2 s CPU** per request (async I/O doesn't count).
- 150 s request idle timeout, then a 504.
- 100 functions per project on Free.
- Outbound ports 25 and 587 are blocked.
- `text/html` responses become `text/plain` without a custom domain.
- No Web Workers. No multithreaded node libraries (for example sharp).

**Background tasks:**
- Call `EdgeRuntime.waitUntil(promise)` **without** `await`. Types come from `import "@supabase/functions-js/edge-runtime.d.ts"` (in the scaffold).
- `addEventListener('beforeunload', ev => ev.detail?.reason)` fires before shutdown.
- Background tasks are capped by the same wall-clock, CPU and memory limits.
- Locally you need `policy = "per_worker"`.
- Source: https://supabase.com/docs/guides/functions/background-tasks

**Calling one function from another:**
```ts
const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default'];
const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/embed`, {
  method: 'POST', headers: { apikey: secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
```
- The called function uses `verify_jwt=false` and `withSupabase({auth:'secret'})`.
- Alternatively, forward the user's `Authorization` header plus the publishable key in `apikey` to keep the user's identity.
- Going over the rate limit throws `Deno.errors.RateLimitError`, which has `retryAfterMs`.
- **Conflicting limit:** the docs say 30 requests per trace per 60 s. The 2026-03-11 changelog says "a minimum of 5,000 requests per minute per chain". Keep call chains shallow.
- Sources: https://supabase.com/docs/guides/functions/recursive-functions and https://supabase.com/changelog/43644-edge-functions-rate-limits-on-recursive-nested-edge-functions-calls

**`supabase.functions.invoke(name, {body, headers, method, region, signal, timeout})`** (functions-js source):
- Body handling:
  - A plain object is sent as JSON.
  - A string gets `text/plain`.
  - `Blob`/`File` get their own type, or `application/octet-stream`.
  - `FormData` is sent as multipart.
- `method` can be `POST`, `GET`, `PUT`, `PATCH` or `DELETE`.
- Errors are `FunctionsHttpError` (read the body with `await error.context.json()`), `FunctionsRelayError` and `FunctionsFetchError`.
- **Gotcha:** for Edge Functions, supabase-js never sends a `sb_publishable_`/`sb_secret_` key as the `Bearer`. It uses `omitApiKeyAsBearer` in `packages/core/supabase-js/src/lib/fetch.ts`. Without a session there is no `Authorization` header, so a `verify_jwt=true` function returns 401. Call `signInAnonymously()` first.

**Minimal user-facing function:**
```ts
// supabase/functions/report/index.ts   (config.toml: [functions.report] verify_jwt = true)
import { withSupabase } from "npm:@supabase/server@^1";
export default { fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
  const { text } = await req.json();
  const ai = await fetch("https://<ai-endpoint>", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("AI_KEY")}` }, body: JSON.stringify({ text }) });
  const { data, error } = await ctx.supabase.from("reports").insert({ user_id: ctx.userClaims!.id, text }).select().single();
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json(data);
}) };
```

---

## 4. pgvector, PostGIS and Realtime

**Extensions** — install into the `extensions` schema, never `public`:
```sql
create extension if not exists vector with schema extensions;
create extension if not exists postgis with schema extensions;
```
- Source: https://supabase.com/docs/guides/database/extensions/postgis

**Vectors:**
- Column type: `embedding extensions.vector(768)`.
- Index:
  ```sql
  create index on reports using hnsw (embedding extensions.vector_cosine_ops);
  ```
  The operator is `<=>`.
- HNSW can index up to 2000 dimensions for `vector`. Above that, use a `halfvec` index:
  ```sql
  create index on documents using hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
  ```
- With pgvector 0.8.0+, `hnsw.iterative_scan` (`strict_order` or `relaxed_order`; default off) is needed for filtered queries to return the full `LIMIT`.
- Match function pattern: `where embedding <=> q < 1 - threshold order by embedding <=> q limit least(n,200)`.
- In functions with `set search_path = ''`, qualify the operator: `operator(extensions.<=>)`.
- Sources: https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes and https://supabase.com/docs/guides/ai/semantic-search

**Geography:**
- Column and index:
  ```sql
  location extensions.geography(Point,4326)
  create index … using gist (location);
  ```
- Insert as `extensions.st_point(lng, lat)` — **longitude first** — or send the WKT string `'POINT(lng lat)'` from supabase-js.
- Reads return hex EWKB, e.g. `0101000020E6…`.
- Get lat/lng with `extensions.st_y(location::extensions.geometry)` for lat and `st_x(...)` for lng.
- Queries:
  - `ST_DWithin(geog, geog, meters, use_spheroid=true)`
  - `ST_Distance(geog, geog)`, which returns metres
  - `ST_Covers(geog_poly, geog_point)`
  - KNN ordering: `order by location operator(extensions.<->) extensions.st_point(lng,lat)::extensions.geography`
- Sources: https://postgis.net/docs/ST_DWithin.html, https://postgis.net/docs/ST_Covers.html, https://postgis.net/docs/ST_Distance.html

**View that exposes lat/lng:**
```sql
create view public.reports_map with (security_invoker = true) as
  select id, category, created_at,
         extensions.st_y(location::extensions.geometry) as lat,
         extensions.st_x(location::extensions.geometry) as lng
  from public.reports;
grant select on public.reports_map to anon, authenticated;
```
- `security_invoker` makes the view apply the RLS of the underlying table.
- Sources: https://supabase.com/docs/guides/database/postgres/row-level-security and https://supabase.com/docs/guides/database/database-advisors

**Realtime `postgres_changes`:**
- **Views cannot be subscribed to.** Postgres: "Only persistent base tables and partitioned tables can be part of a publication… regular views cannot". Subscribe to the base table instead.
- Requirements:
  - `alter publication supabase_realtime add table public.reports;`
  - The subscribing role needs `SELECT` granted, plus an RLS select policy.
- RLS is checked per subscriber, as the subscriber's role.
- UPDATE events can be dropped if the new row no longer passes the policy.
- `alter table … replica identity full` gives `old` records. With RLS on, `old` still contains only the primary key, and DELETE events are not filtered by RLS.
- Filters: `filter:'col=eq.val'` or `postgresChangesFilter()`; `select:[cols]`.
- Above about 3,000 concurrent subscribers, use Broadcast with `realtime.broadcast_changes()`, which needs private channels.
- Public (non-user) Realtime connections are capped at 24 h.
- **Design tip (my inference):** a geography column arrives in the payload as hex. Also store plain `lat`/`lng` double columns, and derive `location` from them, e.g. `generated always as (extensions.st_point(lng, lat, 4326)::extensions.geography) stored`. A community bug report shows this pattern working on PG 15; I have not verified it on Supabase. Whether generated columns appear in Realtime payloads is also unverified.
- Sources: https://supabase.com/docs/guides/realtime/postgres-changes, https://supabase.com/kb/troubleshooting/realtime-postgres-changes-troubleshooting, https://www.postgresql.org/docs/17/sql-createpublication.html

**Versions (npm, checked today):**
- `@supabase/supabase-js` latest is **2.119.0** (2026-11-04). The `next` tag is 3.0.0-next.29.
- `@supabase/server` latest is 1.9.2. Its framework adapters (Hono, H3, Elysia, NestJS) are deprecated and will be removed on 2026-12-01.
- CLI npm `supabase`: latest is 3.1.0; the newest v2 is 2.122.1.

---

## 5. Migrations, link and project create (CLI v2.118 syntax)

**Create a project:**
```
supabase projects create <name> --org-id <org-slug> --db-password <pw> --region ap-south-1 [--size micro] [--high-availability]
```
- `--org-id` takes the org **slug** (help example: `cool-green-pqdr0qc`). Get it from `supabase orgs list`.
- `--size` choices: micro, small, medium, large, xlarge, 2xlarge … 48xlarge*. On Free, leave `--size` out.
- `--region` choices: ap-east-1, ap-northeast-1, ap-northeast-2, **ap-south-1 (Mumbai)**, **ap-southeast-1 (Singapore)**, ap-southeast-2, ca-central-1, eu-central-1, eu-central-2, eu-north-1, eu-west-1/2/3, sa-east-1, us-east-1/2, us-west-1/2.
- Source: https://supabase.com/docs/guides/platform/regions

**Link:**
```
supabase link --project-ref <ref> [-p <db-pw>]
```
- The password is optional. Link writes `supabase/.temp/project-ref`.
- With an access token, the CLI can mint a **temporary login role** through the Management API, so `db push` works without the DB password. You can also set `SUPABASE_DB_PASSWORD` or pass `-p`.

**Migration workflow:**
1. `supabase migration new <name>` creates `supabase/migrations/<timestamp>_<name>.sql`.
2. `supabase db push` (in v2 the default target is the linked project; `--linked` is explicit). Useful flags: `--dry-run`, `--include-all`, `--include-seed`.
3. Out of sync? Use `supabase migration list` / `supabase migration repair --status applied|reverted <ts>`.
- Never change the remote schema in the dashboard.
- In v2.118, `db push` and `functions deploy` prompt; pass the global `--yes` in scripts.
- `supabase db query --linked "<sql>"` runs SQL through the Management API.
- Sources: https://supabase.com/docs/guides/deployment/database-migrations and https://supabase.com/docs/guides/local-development/cli/migrating-to-v3

**Migration template to start from:** extensions in `extensions`; tables with explicit GRANTs and RLS; `alter publication supabase_realtime add table …`; storage bucket insert; `storage.objects` policies.

---

## 6. Not verified, or in conflict

1. Whether a project created in November 2026 has any legacy keys. Supabase's timeline says no; I didn't create a project to check. Use `GET /v1/projects/{ref}/api-keys/legacy`.
2. The `verify_jwt` docs disagree about `Bearer sb_…`: one says it is accepted for compatibility, another says it gives `Invalid JWT`. Use only `apikey` plus `verify_jwt=false`.
3. The function-to-function rate limit: 30 per trace per 60 s in the docs, versus at least 5,000 per minute per chain in the changelog.
4. The shape of the `POST /database/query` response (the spec says 201 with no schema) and of pause/restore responses (200, no body).
5. Raw `fetch` to Storage with only `apikey: sb_secret_…`. supabase-js sends both `apikey` and `Authorization: Bearer <key>` for non-function services. Prefer supabase-js or SQL.
6. Generated geography columns in Realtime payloads, and whether `extensions.st_point(...)::geography` is allowed in a STORED generated column on Supabase.
7. The PowerShell keyring-read snippet is untested (blocked by the permission classifier).
8. The exact pgvector version on new projects. The docs reference 0.8.0 features; check with `select * from pg_extension where extname='vector'`.
9. Default JWT signing algorithm for new projects. Asymmetric is the default (RS256 or ES256); a Studio PR proposes Ed25519. Check `GET /v1/projects/{ref}/config/auth/signing-keys` or `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`.
