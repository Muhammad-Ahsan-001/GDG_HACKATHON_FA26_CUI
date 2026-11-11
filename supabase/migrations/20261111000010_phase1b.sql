-- Awaaz Phase 1b (docs/CONTRACT-1B.md): AI intake attributes + conversation, voice onboarding, SOS (women's safety).
--   reports   + attributes, conversation, user_urgency, intake_session_id, is_private
--   clusters  + attributes (merged by recompute_cluster), user_urgency (max), is_private, sos_session_id
--   profiles  + home_area, onboarded_at ; RPC complete_onboarding ; onboarded_at protected (RPC / service role only)
--   sos_sessions + sos_chunks (+ RLS, realtime, view sos_sessions_view with security_invoker)
--   views     map_pins / public_reports exclude private rows and gain attributes + user_urgency;
--             my_assignments gains attributes, user_urgency, is_private, sos_session_id
--   private clusters are hidden from the public clusters table policy (realtime map feed) and from match_cluster.

-- ================================================================ reports
alter table public.reports
  add column attributes        jsonb not null default '{}'::jsonb,
  add column conversation      jsonb,
  add column user_urgency      text,
  add column intake_session_id text,
  add column is_private        boolean not null default false;

alter table public.reports
  add constraint reports_attributes_object_chk   check (jsonb_typeof(attributes) = 'object'),
  add constraint reports_conversation_array_chk  check (conversation is null or jsonb_typeof(conversation) = 'array'),
  add constraint reports_user_urgency_chk        check (user_urgency is null or user_urgency in ('emergency', 'urgent', 'can_wait'));

create index reports_intake_session_idx on public.reports (intake_session_id) where intake_session_id is not null;
create index reports_private_idx on public.reports (cluster_id) where is_private;

-- ================================================================ clusters
alter table public.clusters
  add column attributes     jsonb not null default '{}'::jsonb,
  add column user_urgency   text,
  add column is_private     boolean not null default false,
  add column sos_session_id uuid;

alter table public.clusters
  add constraint clusters_attributes_object_chk check (jsonb_typeof(attributes) = 'object'),
  add constraint clusters_user_urgency_chk      check (user_urgency is null or user_urgency in ('emergency', 'urgent', 'can_wait'));

create index clusters_private_idx on public.clusters (created_at desc) where is_private;

-- ================================================================ profiles
alter table public.profiles
  add column home_area    text check (home_area is null or length(home_area) <= 160),
  add column onboarded_at timestamptz;

-- ================================================================ SOS sessions + chunks
create table public.sos_sessions (
  id               uuid primary key,                -- client-generated session id (start is idempotent)
  user_id          uuid not null references public.profiles (id) on delete cascade,
  trigger          text not null default 'button' check (trigger in ('button', 'volume', 'shake', 'shortcut')),
  status           text not null default 'monitoring'
                   check (status in ('monitoring', 'alerted', 'safe', 'cancelled', 'resolved')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  alerted_at       timestamptz,
  last_location    extensions.geography(Point, 4326),
  last_location_at timestamptz,
  last_accuracy_m  real,                            -- extra (not in the contract list): GPS accuracy of last_location
  threat_level     text not null default 'none' check (threat_level in ('none', 'possible', 'high')),
  threat_reason    text,
  transcript       text,
  cluster_id       uuid references public.clusters (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index sos_sessions_user_idx on public.sos_sessions (user_id, started_at desc);
create index sos_sessions_cluster_idx on public.sos_sessions (cluster_id) where cluster_id is not null;
create index sos_sessions_active_idx on public.sos_sessions (status) where status in ('monitoring', 'alerted');

create trigger sos_sessions_set_updated_at before update on public.sos_sessions
  for each row execute function public.set_updated_at();

create table public.sos_chunks (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.sos_sessions (id) on delete cascade,
  seq          int not null check (seq >= 0),
  audio_path   text,
  transcript   text,
  threat_level text check (threat_level is null or threat_level in ('none', 'possible', 'high')),
  created_at   timestamptz not null default now(),
  constraint sos_chunks_session_seq_key unique (session_id, seq)
);

alter table public.clusters
  add constraint clusters_sos_session_fk
  foreign key (sos_session_id) references public.sos_sessions (id) on delete set null;
create index clusters_sos_session_idx on public.clusters (sos_session_id) where sos_session_id is not null;

-- ================================================================ helpers
-- Can the caller see a PRIVATE (SOS) cluster? admin, an org owner with an assignment on it, a reporter in it,
-- or the owner of the SOS session it came from. Used by the clusters RLS policy (public map never sees them).
create or replace function public.can_view_private_cluster(p_cluster_id uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions
as $$
  select auth.uid() is not null and (
    public.is_admin()
    or exists (select 1 from public.assignments a
               where a.cluster_id = p_cluster_id and a.org_id = any (public.my_org_ids()))
    or exists (select 1 from public.reports r
               where r.cluster_id = p_cluster_id and r.reporter_id = auth.uid())
    or exists (select 1 from public.sos_sessions s
               where s.cluster_id = p_cluster_id and s.user_id = auth.uid())
  );
$$;

-- ================================================================ RLS
alter table public.sos_sessions enable row level security;
alter table public.sos_chunks   enable row level security;

-- clusters: public map data EXCEPT private (SOS) clusters, which only their stakeholders can read.
drop policy clusters_select on public.clusters;
create policy clusters_select on public.clusters
  for select to anon, authenticated
  using (not is_private or public.can_view_private_cluster(id));

-- sos_sessions: owner, admin, or the owner of an org that has an assignment on the session's cluster.
create policy sos_sessions_select on public.sos_sessions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.is_admin())
    or (
      cluster_id is not null
      and exists (
        select 1 from public.assignments a
        where a.cluster_id = sos_sessions.cluster_id
          and a.org_id in (select unnest(public.my_org_ids()))
      )
    )
  );

-- sos_chunks: visible when the parent session is visible (sos_sessions RLS applies inside the subquery).
create policy sos_chunks_select on public.sos_chunks
  for select to authenticated
  using (exists (select 1 from public.sos_sessions s where s.id = sos_chunks.session_id));

-- ================================================================ protect onboarded_at (RPC / service role only)
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin') then
    return new;
  end if;
  new.id           := old.id;
  new.role         := old.role;
  new.trust_score  := old.trust_score;
  new.is_demo      := old.is_demo;
  new.created_at   := old.created_at;
  new.onboarded_at := old.onboarded_at;   -- set only by complete_onboarding() (security definer)
  return new;
end
$$;

-- ================================================================ RPCs
-- Duplicate matching never considers private (SOS) reports or clusters.
create or replace function public.match_cluster(
  p_category        public.report_category,
  p_lat             float8,
  p_lng             float8,
  p_embedding       extensions.vector(1536),
  p_embedding_model text,
  p_radius_m        float8 default 300,
  p_hours           float8 default 6,
  p_limit           int default 5
)
returns table (cluster_id uuid, report_id uuid, similarity float8, distance_m float8)
language plpgsql stable security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_pt geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
begin
  if p_embedding is null or p_lat is null or p_lng is null then
    return;
  end if;

  return query
  select b.cluster_id, b.report_id, b.similarity, b.distance_m
  from (
    select distinct on (r.cluster_id)
      r.cluster_id,
      r.id as report_id,
      (1 - (r.embedding <=> p_embedding))::float8 as similarity,
      st_distance(r.location, v_pt)::float8 as distance_m
    from public.reports r
    join public.clusters c on c.id = r.cluster_id
    where r.category = p_category
      and not r.is_spam
      and not r.is_private
      and not c.is_private
      and r.embedding is not null
      and (p_embedding_model is null or r.embedding_model = p_embedding_model)
      and r.created_at >= now() - make_interval(secs => greatest(coalesce(p_hours, 6), 0) * 3600)
      and st_dwithin(r.location, v_pt, greatest(coalesce(p_radius_m, 300), 0))
      and c.status <> 'resolved'
    order by r.cluster_id, r.embedding <=> p_embedding
  ) b
  order by b.similarity desc, b.distance_m asc
  limit greatest(coalesce(p_limit, 5), 1);
end
$$;

-- Recompute a cluster's aggregates from its (non-spam) reports and votes. Returns the updated row.
-- Phase 1b: attributes = merge of the reports' attributes (later reports win per key; a key that was ever
-- 'danger' stays 'danger'; keys only set on the cluster itself are kept), user_urgency = max of the reports',
-- is_private sticks once any report (or the cluster) is private.
create or replace function public.recompute_cluster(p_cluster_id uuid)
returns public.clusters
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_c              public.clusters;
  v_primary        public.reports;
  v_count          int;
  v_reporters      int;
  v_photo_matches  int;
  v_centroid       geography;
  v_urgency        public.urgency_level;
  v_last           timestamptz;
  v_food_servings  int;
  v_food_type      text;
  v_safe_until     timestamptz;
  v_confirms       int;
  v_disputes       int;
  v_photo          text;
  v_user_urgency   text;
  v_private        boolean;
  v_report_attrs   jsonb;
  v_old_attrs      jsonb;
  v_attrs          jsonb;
begin
  select * into v_c from public.clusters where id = p_cluster_id for update;
  if not found then
    raise exception 'cluster_not_found' using errcode = 'P0002';
  end if;

  select count(*)::int,
         count(distinct r.reporter_id)::int,
         (count(*) filter (where r.photo_check -> 'matches_claim' = 'true'::jsonb))::int,
         st_centroid(st_collect(r.location::geometry))::geography,
         max(r.urgency),
         max(r.created_at),
         max(r.food_servings),
         min(r.safe_until),
         (array['can_wait', 'urgent', 'emergency'])[
           max(case r.user_urgency when 'emergency' then 3 when 'urgent' then 2 when 'can_wait' then 1 end)],
         bool_or(r.is_private)
    into v_count, v_reporters, v_photo_matches, v_centroid, v_urgency, v_last, v_food_servings, v_safe_until,
         v_user_urgency, v_private
  from public.reports r
  where r.cluster_id = p_cluster_id and not r.is_spam;

  select r.food_type into v_food_type
  from public.reports r
  where r.cluster_id = p_cluster_id and not r.is_spam and r.food_type is not null
  order by r.created_at desc
  limit 1;

  -- attributes: latest report wins per key; 'danger' severity sticks
  with kv as (
    select e.key as k, e.value as v, r.created_at as at, r.id as rid
    from public.reports r
    cross join lateral jsonb_each(case when jsonb_typeof(r.attributes) = 'object' then r.attributes else '{}'::jsonb end) e
    where r.cluster_id = p_cluster_id and not r.is_spam and jsonb_typeof(e.value) = 'object'
  ),
  latest as (
    select distinct on (kv.k) kv.k, kv.v from kv order by kv.k, kv.at desc, kv.rid desc
  ),
  danger as (
    select kv.k, bool_or(kv.v ->> 'severity' = 'danger') as d from kv group by kv.k
  )
  select coalesce(jsonb_object_agg(l.k, case when dg.d then l.v || jsonb_build_object('severity', 'danger') else l.v end),
                  '{}'::jsonb)
    into v_report_attrs
  from latest l
  join danger dg on dg.k = l.k;

  v_old_attrs := case when jsonb_typeof(v_c.attributes) = 'object' then v_c.attributes else '{}'::jsonb end;
  select coalesce(jsonb_object_agg(
           e.key,
           case
             when jsonb_typeof(e.value) = 'object'
                  and coalesce(e.value ->> 'severity', '') <> 'danger'
                  and (v_old_attrs -> e.key ->> 'severity') = 'danger'
               then e.value || jsonb_build_object('severity', 'danger')
             else e.value
           end), '{}'::jsonb)
    into v_attrs
  from jsonb_each(v_old_attrs || coalesce(v_report_attrs, '{}'::jsonb)) e;

  -- primary report: keep the current one if it still belongs to the cluster, else the earliest report
  select * into v_primary from public.reports r
  where r.id = v_c.primary_report_id and r.cluster_id = p_cluster_id;
  if not found then
    select * into v_primary from public.reports r
    where r.cluster_id = p_cluster_id and not r.is_spam
    order by r.created_at asc, r.id
    limit 1;
  end if;

  -- distinct users across all votes of the cluster
  select (count(distinct v.user_id) filter (where v.vote = 'confirm'))::int,
         (count(distinct v.user_id) filter (where v.vote = 'dispute'))::int
    into v_confirms, v_disputes
  from public.report_votes v
  where v.cluster_id = p_cluster_id
     or v.report_id in (select r.id from public.reports r where r.cluster_id = p_cluster_id);

  -- first image of the cluster (public bucket path)
  select m.storage_path into v_photo
  from public.report_media m
  join public.reports r on r.id = m.report_id
  where r.cluster_id = p_cluster_id and not r.is_spam
    and m.type = 'image' and m.bucket = 'report-images'
  order by m.created_at, m.id
  limit 1;

  update public.clusters c set
    report_count      = coalesce(v_count, 0),
    reporter_count    = coalesce(v_reporters, 0),
    confirm_count     = coalesce(v_confirms, 0),
    dispute_count     = coalesce(v_disputes, 0),
    photo_match_count = coalesce(v_photo_matches, 0),
    centroid          = coalesce(v_centroid, c.centroid),
    urgency           = coalesce(v_urgency, c.urgency),
    primary_report_id = coalesce(v_primary.id, c.primary_report_id),
    title_en          = coalesce(c.title_en, v_primary.title_en),
    title_ur          = coalesce(c.title_ur, v_primary.title_ur),
    summary_en        = coalesce(c.summary_en, v_primary.summary_en),
    summary_ur        = coalesce(c.summary_ur, v_primary.summary_ur),
    photo_path        = coalesce(v_photo, c.photo_path),
    food_servings     = coalesce(v_food_servings, c.food_servings),
    food_type         = coalesce(v_food_type, c.food_type),
    safe_until        = coalesce(v_safe_until, c.safe_until),
    last_report_at    = coalesce(v_last, c.last_report_at),
    attributes        = coalesce(v_attrs, c.attributes),
    user_urgency      = coalesce(v_user_urgency, c.user_urgency),
    is_private        = c.is_private or coalesce(v_private, false)
  where c.id = p_cluster_id
  returning c.* into v_c;

  return v_c;
end
$$;

-- Confirm / dispute a pin (cluster). Private (SOS) clusters cannot be voted on (they are not public).
create or replace function public.cast_vote(p_cluster_id uuid, p_vote public.vote_type)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_primary uuid;
  v_c       public.clusters;
begin
  if v_uid is null then
    raise exception 'auth_required' using hint = 'Sign in to vote';
  end if;
  if p_vote is null then
    raise exception 'invalid_vote';
  end if;

  select * into v_c from public.clusters where id = p_cluster_id;
  if not found or v_c.is_private then
    raise exception 'cluster_not_found';
  end if;

  if exists (select 1 from public.reports r where r.cluster_id = p_cluster_id and r.reporter_id = v_uid) then
    raise exception 'own_report' using hint = 'You cannot vote on an issue you reported';
  end if;

  v_primary := v_c.primary_report_id;
  if v_primary is null then
    select r.id into v_primary from public.reports r
    where r.cluster_id = p_cluster_id and not r.is_spam
    order by r.created_at asc, r.id limit 1;
  end if;
  if v_primary is null then
    raise exception 'cluster_has_no_reports';
  end if;

  -- one vote per user per cluster
  delete from public.report_votes v
  where v.user_id = v_uid and v.cluster_id = p_cluster_id and v.report_id <> v_primary;

  insert into public.report_votes (report_id, cluster_id, user_id, vote)
  values (v_primary, p_cluster_id, v_uid, p_vote)
  on conflict (report_id, user_id)
  do update set vote = excluded.vote, cluster_id = excluded.cluster_id, created_at = now();

  v_c := public.recompute_cluster(p_cluster_id);

  return json_build_object(
    'confirm_count', v_c.confirm_count,
    'dispute_count', v_c.dispute_count,
    'cluster_id',    v_c.id,
    'vote',          p_vote,
    'status',        v_c.status,
    'confidence',    v_c.confidence
  );
end
$$;

-- Finish onboarding for the CALLER: name, home area, language, phone (optional). Sets onboarded_at = now().
-- Blank inputs keep the current value. Returns the caller's profile row.
create or replace function public.complete_onboarding(
  p_display_name text,
  p_home_area    text,
  p_language     text,
  p_phone        text default null
)
returns public.profiles
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := nullif(btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g')), '');
  v_area  text := nullif(btrim(regexp_replace(coalesce(p_home_area, ''), '\s+', ' ', 'g')), '');
  v_lang  text := lower(btrim(coalesce(p_language, '')));
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g'), '');
  v_p     public.profiles;
begin
  if v_uid is null then
    raise exception 'auth_required';
  end if;
  if v_lang = '' then
    v_lang := null;
  elsif v_lang not in ('ur', 'en') then
    raise exception 'invalid_language' using hint = 'ur | en';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'invalid_phone' using hint = 'Digits only, optionally starting with +';
  end if;

  -- the auth trigger normally creates the profile; be safe for users created before it existed
  insert into public.profiles (id) values (v_uid) on conflict (id) do nothing;

  update public.profiles p set
    display_name = coalesce(left(v_name, 80), p.display_name),
    home_area    = coalesce(left(v_area, 160), p.home_area),
    language     = coalesce(v_lang, p.language),
    phone        = coalesce(left(v_phone, 20), p.phone),
    onboarded_at = now()
  where p.id = v_uid
  returning p.* into v_p;

  return v_p;
end
$$;

-- ================================================================ views (append-only column changes => CREATE OR REPLACE)
create or replace view public.map_pins with (security_invoker = false) as
select
  c.id,
  c.category,
  c.urgency,
  c.status,
  extensions.st_y(c.centroid::extensions.geometry)::float8 as lat,
  extensions.st_x(c.centroid::extensions.geometry)::float8 as lng,
  c.report_count,
  c.reporter_count,
  c.confirm_count,
  c.dispute_count,
  c.confidence,
  c.ai_reason,
  c.title_en,
  c.title_ur,
  c.summary_en,
  c.summary_ur,
  public.report_image_url(c.photo_path) as photo_url,
  c.food_servings,
  c.food_type,
  c.safe_until,
  c.claimed_org_name,
  c.created_at,
  c.updated_at,
  c.last_report_at,
  c.attributes,
  c.user_urgency
from public.clusters c
where not c.is_private
  and not (c.status = 'resolved' and c.updated_at < now() - interval '24 hours');

create or replace view public.public_reports with (security_invoker = false) as
select
  r.id,
  r.cluster_id,
  r.category,
  r.urgency,
  r.status,
  r.title_en,
  r.title_ur,
  r.summary_en,
  r.summary_ur,
  r.language,
  r.input_modes,
  (img.storage_path is not null or 'photo' = any (r.input_modes)) as has_photo,
  public.report_image_url(img.storage_path) as photo_url,
  r.created_at,
  coalesce(r.reporter_id = auth.uid(), false) as is_mine,
  r.attributes,
  r.user_urgency
from public.reports r
left join lateral (
  select m.storage_path
  from public.report_media m
  where m.report_id = r.id and m.type = 'image' and m.bucket = 'report-images'
  order by m.created_at, m.id
  limit 1
) img on true
where not r.is_spam
  and not r.is_private
  and r.cluster_id is not null;

create or replace view public.my_assignments with (security_invoker = false) as
select
  a.id as assignment_id,
  a.org_id,
  o.name as org_name,
  o.org_type,
  a.status,
  a.distance_m,
  a.note,
  a.alerted_at,
  a.claimed_at,
  a.in_progress_at,
  a.resolved_at,
  a.cluster_id,
  c.category,
  c.urgency,
  c.status as cluster_status,
  extensions.st_y(c.centroid::extensions.geometry)::float8 as lat,
  extensions.st_x(c.centroid::extensions.geometry)::float8 as lng,
  c.report_count,
  c.confidence,
  c.ai_reason,
  c.title_en,
  c.title_ur,
  c.summary_en,
  c.summary_ur,
  public.report_image_url(c.photo_path) as photo_url,
  c.food_servings,
  c.food_type,
  c.safe_until,
  -- extras (beyond the contract list)
  a.report_id,
  c.reporter_count,
  c.confirm_count,
  c.dispute_count,
  c.claimed_org_id,
  c.claimed_org_name,
  pr.address_text,
  c.created_at as cluster_created_at,
  c.last_report_at,
  -- Phase 1b
  c.attributes,
  c.user_urgency,
  c.is_private,
  c.sos_session_id
from public.assignments a
join public.organizations o on o.id = a.org_id
join public.clusters c on c.id = a.cluster_id
left join public.reports pr on pr.id = c.primary_report_id
where o.owner_id = auth.uid()
   or (select public.is_admin());

-- SOS sessions with lat/lng; security_invoker = true so the sos_sessions RLS policy applies to the caller.
create view public.sos_sessions_view with (security_invoker = true) as
select
  s.id,
  s.user_id,
  s.trigger,
  s.status,
  s.started_at,
  s.ended_at,
  s.alerted_at,
  s.threat_level,
  s.threat_reason,
  s.transcript,
  s.cluster_id,
  extensions.st_y(s.last_location::extensions.geometry)::float8 as lat,
  extensions.st_x(s.last_location::extensions.geometry)::float8 as lng,
  -- extras
  s.last_location_at,
  s.last_accuracy_m,
  s.created_at,
  s.updated_at
from public.sos_sessions s;

-- ================================================================ grants (project defaults grant everything; tighten)
revoke all on table public.sos_sessions, public.sos_chunks, public.sos_sessions_view from anon, authenticated, public;
grant all on table public.sos_sessions, public.sos_chunks, public.sos_sessions_view to service_role;
grant select on table public.sos_sessions, public.sos_chunks, public.sos_sessions_view to authenticated;

-- own profile: home_area is client-writable like display_name (onboarded_at is NOT: complete_onboarding only)
grant update (home_area) on table public.profiles to authenticated;

revoke execute on function
  public.can_view_private_cluster(uuid),
  public.complete_onboarding(text, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.can_view_private_cluster(uuid),
  public.complete_onboarding(text, text, text, text)
to service_role;
-- RLS helper (evaluated as the querying role) + user RPC
grant execute on function public.can_view_private_cluster(uuid) to anon, authenticated;
grant execute on function public.complete_onboarding(text, text, text, text) to authenticated;

-- ================================================================ realtime: owner sees status live, police see location
alter publication supabase_realtime add table public.sos_sessions;
alter table public.sos_sessions replica identity full;

-- ================================================================ data
-- demo accounts skip onboarding
update public.profiles set onboarded_at = now() where is_demo and onboarded_at is null;

notify pgrst, 'reload schema';
