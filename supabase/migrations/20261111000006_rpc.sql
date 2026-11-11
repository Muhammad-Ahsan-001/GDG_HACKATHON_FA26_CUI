-- Awaaz: RPCs. All security definer with search_path = public, extensions.
-- Errors are raised with a short machine code as the message (PostgREST returns it as error.message).

-- ================================================================ service-role RPCs

-- Candidate clusters for a new report: same category, non-spam reports with an embedding of the same
-- model, created within p_hours and within p_radius_m, cluster not resolved. Best report per cluster,
-- ordered by cosine similarity desc. NO threshold here: the Edge Function applies config thresholds.
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
         min(r.safe_until)
    into v_count, v_reporters, v_photo_matches, v_centroid, v_urgency, v_last, v_food_servings, v_safe_until
  from public.reports r
  where r.cluster_id = p_cluster_id and not r.is_spam;

  select r.food_type into v_food_type
  from public.reports r
  where r.cluster_id = p_cluster_id and not r.is_spam and r.food_type is not null
  order by r.created_at desc
  limit 1;

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
    last_report_at    = coalesce(v_last, c.last_report_at)
  where c.id = p_cluster_id
  returning c.* into v_c;

  return v_c;
end
$$;

-- Approved organisations whose service area covers the point and that handle the category, nearest centre first.
create or replace function public.find_responders(
  p_lat      float8,
  p_lng      float8,
  p_category public.report_category,
  p_limit    int default 5
)
returns table (org_id uuid, org_name text, org_type public.org_type, owner_id uuid, distance_m float8)
language plpgsql stable security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_pt geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
begin
  return query
  select o.id, o.name, o.org_type, o.owner_id, st_distance(o.center, v_pt)::float8 as d
  from public.organizations o
  where o.approved
    and p_category = any (o.categories)
    and st_covers(o.service_area, v_pt)
  order by d asc, o.created_at asc
  limit greatest(coalesce(p_limit, 5), 1);
end
$$;

-- FCM tokens of citizens seen within p_radius_m of the point in the last 48 h.
create or replace function public.nearby_citizen_tokens(
  p_lat      float8,
  p_lng      float8,
  p_radius_m float8 default 1000,
  p_exclude  uuid[] default '{}'
)
returns table (user_id uuid, fcm_token text, language text)
language plpgsql stable security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_pt geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
begin
  return query
  select p.id, t.fcm_token, p.language
  from public.profiles p
  join public.device_tokens t on t.user_id = p.id
  where p.role = 'citizen'
    and p.last_location is not null
    and p.last_location_at > now() - interval '48 hours'
    and st_dwithin(p.last_location, v_pt, greatest(coalesce(p_radius_m, 1000), 0))
    and not (p.id = any (coalesce(p_exclude, '{}'::uuid[])));
end
$$;

-- ================================================================ user RPCs

-- Confirm / dispute a pin (cluster). Vote is stored against the cluster's primary report.
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
  if not found then
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

-- Pick citizen / ngo / responder for yourself. Never admin; an admin cannot change role.
create or replace function public.set_my_role(p_role public.user_role)
returns public.user_role
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_current public.user_role;
begin
  if v_uid is null then
    raise exception 'auth_required';
  end if;
  if p_role is null or p_role = 'admin' then
    raise exception 'role_not_allowed';
  end if;

  select p.role into v_current from public.profiles p where p.id = v_uid;
  if not found then
    insert into public.profiles (id, role) values (v_uid, p_role);
    return p_role;
  end if;
  if v_current = 'admin' then
    raise exception 'admin_locked';
  end if;

  update public.profiles set role = p_role where id = v_uid;
  return p_role;
end
$$;

-- Last known location (used for nearby alerts).
create or replace function public.update_my_location(p_lat float8, p_lng float8)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'auth_required';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_location';
  end if;
  update public.profiles
     set last_location = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
         last_location_at = now()
   where id = v_uid;
end
$$;

-- Register an organisation owned by the caller (approved = false until an admin approves).
-- ngo -> shelter | food_bank | health_ngo ; responder -> rescue_1122 | fire | police | water ; admin -> any.
create or replace function public.register_organization(
  p_name            text,
  p_org_type        public.org_type,
  p_categories      public.report_category[],
  p_lat             float8,
  p_lng             float8,
  p_radius_m        int,
  p_phone           text default null,
  p_polygon_geojson json default null
)
returns uuid
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_role    public.user_role;
  v_name    text := btrim(coalesce(p_name, ''));
  v_cats    public.report_category[];
  v_geom    geometry;
  v_center  geography;
  v_area    geography;
  v_radius  int := p_radius_m;
  v_id      uuid;
  v_gj      json := p_polygon_geojson;
begin
  if v_uid is null then
    raise exception 'auth_required';
  end if;
  select p.role into v_role from public.profiles p where p.id = v_uid;
  if v_role is null then
    raise exception 'profile_not_found';
  end if;
  if p_org_type is null then
    raise exception 'org_type_required';
  end if;
  if v_role = 'citizen'
     or (v_role = 'ngo' and p_org_type not in ('shelter', 'food_bank', 'health_ngo'))
     or (v_role = 'responder' and p_org_type not in ('rescue_1122', 'fire', 'police', 'water')) then
    raise exception 'org_type_role_mismatch'
      using hint = 'ngo: shelter/food_bank/health_ngo; responder: rescue_1122/fire/police/water';
  end if;
  if length(v_name) < 2 then
    raise exception 'name_required';
  end if;

  -- categories: de-duplicated; sensible defaults per org type when none given
  select coalesce(array_agg(distinct c), '{}') into v_cats from unnest(coalesce(p_categories, '{}')) c;
  if cardinality(v_cats) = 0 then
    v_cats := case p_org_type
      when 'shelter'     then array['food', 'flood']::public.report_category[]
      when 'food_bank'   then array['food']::public.report_category[]
      when 'health_ngo'  then array['health']::public.report_category[]
      when 'rescue_1122' then array['hazard', 'fire', 'flood', 'health']::public.report_category[]
      when 'fire'        then array['fire']::public.report_category[]
      when 'police'      then array['safety']::public.report_category[]
      when 'water'       then array['water', 'flood']::public.report_category[]
    end;
  end if;

  -- optional explicit polygon (GeoJSON Polygon geometry or a Feature wrapping one)
  if v_gj is not null then
    if (v_gj ->> 'type') = 'Feature' then
      v_gj := v_gj -> 'geometry';
    end if;
    begin
      v_geom := st_setsrid(st_geomfromgeojson(v_gj::text), 4326);
    exception when others then
      raise exception 'invalid_polygon';
    end;
    if geometrytype(v_geom) <> 'POLYGON' or not st_isvalid(v_geom) then
      raise exception 'invalid_polygon' using hint = 'A single valid GeoJSON Polygon is required';
    end if;
    v_area := v_geom::geography;
  end if;

  if p_lat is not null and p_lng is not null then
    if p_lat not between -90 and 90 or p_lng not between -180 and 180 then
      raise exception 'invalid_location';
    end if;
    v_center := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
  elsif v_geom is not null then
    v_center := st_pointonsurface(v_geom)::geography;
  else
    raise exception 'location_required';
  end if;

  if v_area is null then
    v_radius := least(greatest(coalesce(v_radius, 5000), 100), 100000);
    v_area := st_buffer(v_center, v_radius::float8);
  elsif v_radius is not null then
    v_radius := least(greatest(v_radius, 100), 100000);
  end if;

  insert into public.organizations (owner_id, name, org_type, categories, center, radius_m, service_area, phone, approved)
  values (v_uid, left(v_name, 160), p_org_type, v_cats, v_center, v_radius, v_area,
          nullif(btrim(coalesce(p_phone, '')), ''), false)
  returning id into v_id;

  return v_id;
end
$$;

-- Admin approves / un-approves an organisation.
create or replace function public.approve_organization(p_org_id uuid, p_approved boolean)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using hint = 'Admin only';
  end if;
  update public.organizations set approved = coalesce(p_approved, false) where id = p_org_id;
  if not found then
    raise exception 'org_not_found';
  end if;
end
$$;

-- Responder / NGO workflow on an assignment: claim | start | resolve.
-- Forward-only and idempotent: an action that is already past is a no-op (changed = false).
-- start/resolve sync the cluster + its reports' status; resolve also closes the other orgs' open assignments.
create or replace function public.apply_assignment_action(
  p_assignment_id uuid,
  p_action        text,
  p_note          text default null
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid        uuid := auth.uid();
  v_service    boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_action     text := lower(btrim(coalesce(p_action, '')));
  v_now        timestamptz := now();
  v_a          public.assignments;
  v_org        public.organizations;
  v_prev       public.assignment_status;
  v_changed    boolean := false;
  v_cluster    public.clusters;
  v_reporters  uuid[];
  v_others     uuid[];
begin
  if v_uid is null and not v_service then
    raise exception 'auth_required';
  end if;
  if v_action not in ('claim', 'start', 'resolve') then
    raise exception 'invalid_action' using hint = 'claim | start | resolve';
  end if;

  select * into v_a from public.assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'assignment_not_found';
  end if;
  select * into v_org from public.organizations where id = v_a.org_id;
  if not (v_service or v_org.owner_id = v_uid or public.is_admin()) then
    raise exception 'forbidden' using hint = 'You do not own this organisation';
  end if;

  v_prev := v_a.status;

  if v_action = 'claim' then
    if v_a.status = 'alerted' then
      update public.assignments
         set status = 'claimed', claimed_at = v_now, claimed_by = coalesce(v_uid, claimed_by)
       where id = v_a.id
      returning * into v_a;
      v_changed := true;
      update public.clusters c
         set claimed_org_id   = coalesce(c.claimed_org_id, v_org.id),
             claimed_org_name = case when c.claimed_org_id is null then v_org.name else c.claimed_org_name end
       where c.id = v_a.cluster_id;
    end if;

  elsif v_action = 'start' then
    if v_a.status in ('alerted', 'claimed') then
      update public.assignments
         set status = 'in_progress', in_progress_at = v_now,
             claimed_at = coalesce(claimed_at, v_now), claimed_by = coalesce(claimed_by, v_uid)
       where id = v_a.id
      returning * into v_a;
      v_changed := true;
      update public.clusters c
         set status           = case when c.status = 'resolved' then c.status else 'in_progress'::public.report_status end,
             claimed_org_id   = coalesce(c.claimed_org_id, v_org.id),
             claimed_org_name = case when c.claimed_org_id is null then v_org.name else c.claimed_org_name end
       where c.id = v_a.cluster_id;
      update public.reports r
         set status = 'in_progress'
       where r.cluster_id = v_a.cluster_id and not r.is_spam and r.status <> 'resolved';
    end if;

  else -- resolve
    if v_a.status <> 'resolved' then
      update public.assignments
         set status = 'resolved', resolved_at = v_now,
             claimed_at = coalesce(claimed_at, v_now), claimed_by = coalesce(claimed_by, v_uid)
       where id = v_a.id
      returning * into v_a;
      v_changed := true;
      update public.clusters c
         set status           = 'resolved',
             claimed_org_id   = coalesce(c.claimed_org_id, v_org.id),
             claimed_org_name = case when c.claimed_org_id is null then v_org.name else c.claimed_org_name end
       where c.id = v_a.cluster_id;
      update public.reports r
         set status = 'resolved'
       where r.cluster_id = v_a.cluster_id and not r.is_spam;
      -- the incident is closed for everyone who was alerted
      update public.assignments s
         set status = 'resolved', resolved_at = v_now,
             note = coalesce(s.note, 'Resolved by ' || v_org.name)
       where s.cluster_id = v_a.cluster_id and s.id <> v_a.id and s.status <> 'resolved';
    end if;
  end if;

  if p_note is not null and btrim(p_note) <> '' then
    update public.assignments set note = left(btrim(p_note), 1000) where id = v_a.id
    returning * into v_a;
  end if;

  select * into v_cluster from public.clusters where id = v_a.cluster_id;

  select coalesce(array_agg(distinct r.reporter_id), '{}'::uuid[]) into v_reporters
  from public.reports r
  where r.cluster_id = v_a.cluster_id and not r.is_spam;

  select coalesce(array_agg(distinct o.owner_id), '{}'::uuid[]) into v_others
  from public.assignments s
  join public.organizations o on o.id = s.org_id
  where s.cluster_id = v_a.cluster_id and s.id <> v_a.id and o.owner_id <> v_org.owner_id;

  return json_build_object(
    'assignment_id',       v_a.id,
    'status',              v_a.status,
    'previous_status',     v_prev,
    'changed',             v_changed,
    'cluster_id',          v_a.cluster_id,
    'cluster_status',      v_cluster.status,
    'org_id',              v_org.id,
    'org_name',            v_org.name,
    'reporter_ids',        v_reporters,
    'other_org_owner_ids', v_others
  );
end
$$;

-- Dashboard counters for one org (must be yours, or admin), or all of the caller's orgs (admin: all orgs).
create or replace function public.dashboard_stats(p_org_id uuid default null)
returns json
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_uid       uuid := auth.uid();
  v_admin     boolean := public.is_admin();
  v_service   boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_all       boolean := false;
  v_orgs      uuid[];
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Karachi')) at time zone 'Asia/Karachi';
  v_result    json;
begin
  if v_uid is null and not v_service then
    raise exception 'auth_required';
  end if;

  if p_org_id is not null then
    if not (v_admin or v_service or p_org_id = any (public.my_org_ids())) then
      raise exception 'forbidden';
    end if;
    v_orgs := array[p_org_id];
  elsif v_admin or v_service then
    v_all := true;
  else
    v_orgs := public.my_org_ids();
  end if;

  with a as (
    select s.status, s.alerted_at, s.claimed_at, s.resolved_at, c.category
    from public.assignments s
    join public.clusters c on c.id = s.cluster_id
    where v_all or s.org_id = any (v_orgs)
  )
  select json_build_object(
    'open',                 count(*) filter (where a.status = 'alerted'),
    'claimed',              count(*) filter (where a.status = 'claimed'),
    'in_progress',          count(*) filter (where a.status = 'in_progress'),
    'resolved_today',       count(*) filter (where a.status = 'resolved' and a.resolved_at >= v_day_start),
    'resolved_total',       count(*) filter (where a.status = 'resolved'),
    'total',                count(*),
    'avg_minutes_to_claim', round((avg(extract(epoch from (a.claimed_at - a.alerted_at)) / 60.0)
                                   filter (where a.claimed_at is not null))::numeric, 1),
    'by_category',          coalesce((
                              select json_object_agg(x.category, x.n)
                              from (select a2.category, count(*) as n from a a2
                                    where a2.status <> 'resolved' group by a2.category) x
                            ), '{}'::json)
  ) into v_result
  from a;

  return v_result;
end
$$;

-- Register / refresh this device's FCM token for the caller (re-assigns a token that moved between accounts).
create or replace function public.register_device_token(p_token text, p_user_agent text default null)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'auth_required';
  end if;
  if p_token is null or length(btrim(p_token)) < 10 then
    raise exception 'invalid_token';
  end if;
  insert into public.device_tokens (user_id, fcm_token, user_agent, last_seen_at)
  values (v_uid, btrim(p_token), left(p_user_agent, 400), now())
  on conflict (fcm_token)
  do update set user_id = excluded.user_id, user_agent = coalesce(excluded.user_agent, device_tokens.user_agent),
                last_seen_at = now();
end
$$;
