-- Awaaz: admin operations console (src/pages/Admin.tsx). Admin-only, security-definer RPCs that "see everything".
-- Every function checks is_admin() and raises 'forbidden' otherwise. All return jsonb (lists: {total, rows}).
--   admin_overview()                       counts + 14-day series + response times + top areas
--   admin_list_users(search, role, limit, offset)
--   admin_set_role(user, role) / admin_set_trust(user, trust)
--   admin_list_reports(search, status, category, include_spam, limit, offset)
--   admin_list_sos(limit, offset)
--   admin_set_cluster_status(cluster, status) / admin_mark_spam(report, spam)
--   admin_list_assignments(status, limit, offset)
--   admin_list_clusters(include_resolved)  every pin incl. private SOS clusters (live map)
--   admin_list_notifications(type, limit, offset)
--   admin_activity(limit)                  latest events across reports / assignments / SOS / orgs
-- Storage: admins may read report-audio (voice notes + SOS chunks) to create signed URLs.

-- ================================================================ helpers
create or replace function public.admin_area_of(p_address text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_address is null or btrim(p_address) = '' then null
    when p_address ~ '\m[A-Z]-[0-9]{1,2}' then
      substring(p_address from '\m([A-Z]-[0-9]{1,2})')
      || coalesce(', ' || nullif(btrim(regexp_replace(p_address, '^.*,', '')), ''), '')
    else btrim(regexp_replace(p_address, '^(.*,)?\s*([^,]+,[^,]+)$', '\2'))
  end;
$$;

create or replace function public.admin_guard()
returns void
language plpgsql stable security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using hint = 'Admin only', errcode = '42501';
  end if;
end
$$;

-- ================================================================ overview
create or replace function public.admin_overview()
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';
  v jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'generated_at', now(),
    'users', (
      select jsonb_build_object(
        'total', count(*),
        'anonymous', count(*) filter (where u.is_anonymous),
        'new_today', count(*) filter (where u.created_at >= v_today),
        'active_today', count(*) filter (where u.last_sign_in_at >= v_today),
        'by_role', jsonb_build_object(
          'citizen',   count(*) filter (where p.role = 'citizen'),
          'ngo',       count(*) filter (where p.role = 'ngo'),
          'responder', count(*) filter (where p.role = 'responder'),
          'admin',     count(*) filter (where p.role = 'admin')))
      from public.profiles p
      join auth.users u on u.id = p.id),
    'orgs', (
      select jsonb_build_object(
        'total', count(*),
        'approved', count(*) filter (where o.approved),
        'pending', count(*) filter (where not o.approved),
        'by_type', coalesce((select jsonb_object_agg(t.org_type, t.n)
                             from (select org_type, count(*) n from public.organizations group by org_type) t), '{}'::jsonb))
      from public.organizations o),
    'clusters', (
      select jsonb_build_object(
        'total', count(*),
        'private', count(*) filter (where c.is_private),
        'open', count(*) filter (where c.status <> 'resolved'),
        'by_status', jsonb_build_object(
          'unconfirmed', count(*) filter (where c.status = 'unconfirmed'),
          'verified',    count(*) filter (where c.status = 'verified'),
          'disputed',    count(*) filter (where c.status = 'disputed'),
          'in_progress', count(*) filter (where c.status = 'in_progress'),
          'resolved',    count(*) filter (where c.status = 'resolved')),
        'by_category', coalesce((select jsonb_object_agg(t.category, t.n)
                                 from (select category, count(*) n from public.clusters group by category) t), '{}'::jsonb))
      from public.clusters c),
    'reports', (
      select jsonb_build_object(
        'total', count(*),
        'spam', count(*) filter (where r.is_spam),
        'private', count(*) filter (where r.is_private),
        'today', count(*) filter (where r.created_at >= v_today),
        'voice', count(*) filter (where 'voice' = any (r.input_modes)),
        'photo', count(*) filter (where 'photo' = any (r.input_modes)),
        'text',  count(*) filter (where 'text' = any (r.input_modes)),
        'avg_confidence', round(coalesce(avg(r.confidence) filter (where not r.is_spam), 0)::numeric, 3))
      from public.reports r),
    'assignments', (
      select jsonb_build_object(
        'total', count(*),
        'by_status', jsonb_build_object(
          'alerted',     count(*) filter (where a.status = 'alerted'),
          'claimed',     count(*) filter (where a.status = 'claimed'),
          'in_progress', count(*) filter (where a.status = 'in_progress'),
          'resolved',    count(*) filter (where a.status = 'resolved')))
      from public.assignments a),
    'sos', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where s.status in ('monitoring', 'alerted')),
        'high_threat', count(*) filter (where s.threat_level = 'high'),
        'by_status', jsonb_build_object(
          'monitoring', count(*) filter (where s.status = 'monitoring'),
          'alerted',    count(*) filter (where s.status = 'alerted'),
          'safe',       count(*) filter (where s.status = 'safe'),
          'cancelled',  count(*) filter (where s.status = 'cancelled'),
          'resolved',   count(*) filter (where s.status = 'resolved')))
      from public.sos_sessions s),
    'notifications', (
      select jsonb_build_object(
        'total', count(*),
        'today', count(*) filter (where n.created_at >= v_today),
        'unread', count(*) filter (where n.read_at is null))
      from public.notifications n),
    'response', (
      select jsonb_build_object(
        'avg_min_report_to_claim', round((avg(extract(epoch from (a.claimed_at - coalesce(r.created_at, c.created_at))) / 60)
                                          filter (where a.claimed_at is not null))::numeric, 1),
        'avg_min_claim_to_resolve', round((avg(extract(epoch from (a.resolved_at - a.claimed_at)) / 60)
                                           filter (where a.resolved_at is not null and a.claimed_at is not null))::numeric, 1),
        'avg_min_alert_to_claim', round((avg(extract(epoch from (a.claimed_at - a.alerted_at)) / 60)
                                         filter (where a.claimed_at is not null))::numeric, 1),
        'claimed_count', count(*) filter (where a.claimed_at is not null),
        'resolved_count', count(*) filter (where a.resolved_at is not null))
      from public.assignments a
      join public.clusters c on c.id = a.cluster_id
      left join public.reports r on r.id = coalesce(a.report_id, c.primary_report_id)),
    'per_day', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'reports', coalesce(x.n, 0), 'spam', coalesce(x.spam, 0),
                                                   'sos', coalesce(y.n, 0)) order by d.day), '[]'::jsonb)
      from (
        select ((now() at time zone 'Asia/Karachi')::date - g) as day
        from generate_series(0, 13) g
      ) d
      left join (
        select (r.created_at at time zone 'Asia/Karachi')::date as day,
               count(*) filter (where not r.is_spam) n, count(*) filter (where r.is_spam) spam
        from public.reports r
        where r.created_at >= now() - interval '15 days'
        group by 1
      ) x on x.day = d.day
      left join (
        select (s.started_at at time zone 'Asia/Karachi')::date as day, count(*) n
        from public.sos_sessions s
        where s.started_at >= now() - interval '15 days'
        group by 1
      ) y on y.day = d.day),
    'top_areas', (
      select coalesce(jsonb_agg(jsonb_build_object('area', t.area, 'count', t.n) order by t.n desc, t.area), '[]'::jsonb)
      from (
        select public.admin_area_of(r.address_text) as area, count(*) n
        from public.reports r
        where not r.is_spam and public.admin_area_of(r.address_text) is not null
        group by 1
        order by 2 desc, 1
        limit 8
      ) t)
  ) into v;

  return v;
end
$$;

-- ================================================================ users
create or replace function public.admin_list_users(
  p_search text default null,
  p_role   text default null,
  p_limit  int default 50,
  p_offset int default 0
)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v jsonb;
begin
  perform public.admin_guard();

  with base as (
    select
      p.id, p.role, p.display_name, p.phone, p.language, p.trust_score, p.is_demo, p.home_area, p.onboarded_at,
      p.last_location_at, p.created_at,
      u.email::text as email, u.phone::text as auth_phone, u.last_sign_in_at, coalesce(u.is_anonymous, false) as is_anonymous,
      (select count(*) from public.reports r where r.reporter_id = p.id)::int as report_count,
      (select count(*) from public.reports r where r.reporter_id = p.id and r.is_spam)::int as spam_count,
      (select count(*) from public.organizations o where o.owner_id = p.id)::int as org_count,
      (select count(*) from public.sos_sessions s where s.user_id = p.id)::int as sos_count
    from public.profiles p
    join auth.users u on u.id = p.id
    where (p_role is null or p_role = '' or p_role = 'all'
           or (p_role = 'anonymous' and coalesce(u.is_anonymous, false))
           or p.role::text = p_role)
      and (v_q is null
           or p.display_name ilike '%' || v_q || '%'
           or u.email ilike '%' || v_q || '%'
           or p.phone ilike '%' || v_q || '%'
           or u.phone ilike '%' || v_q || '%'
           or p.home_area ilike '%' || v_q || '%'
           or p.id::text ilike v_q || '%')
  ),
  page as (
    select * from base
    order by coalesce(last_sign_in_at, created_at) desc nulls last, id
    limit least(greatest(coalesce(p_limit, 50), 1), 500) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((select jsonb_agg(to_jsonb(pg) order by coalesce(pg.last_sign_in_at, pg.created_at) desc nulls last, pg.id)
                      from page pg), '[]'::jsonb))
  into v;
  return v;
end
$$;

create or replace function public.admin_set_role(p_user uuid, p_role public.user_role)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_p public.profiles;
begin
  perform public.admin_guard();
  if p_user = auth.uid() then
    raise exception 'cannot_change_self' using hint = 'Admins cannot change their own role';
  end if;
  if p_role is null then
    raise exception 'invalid_role';
  end if;
  update public.profiles set role = p_role where id = p_user returning * into v_p;
  if not found then
    raise exception 'user_not_found';
  end if;
  return jsonb_build_object('id', v_p.id, 'role', v_p.role);
end
$$;

create or replace function public.admin_set_trust(p_user uuid, p_trust real)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_p public.profiles;
begin
  perform public.admin_guard();
  if p_trust is null or p_trust::float8 = 'NaN'::float8 then
    raise exception 'invalid_trust';
  end if;
  update public.profiles set trust_score = least(greatest(p_trust, 0), 1) where id = p_user returning * into v_p;
  if not found then
    raise exception 'user_not_found';
  end if;
  return jsonb_build_object('id', v_p.id, 'trust_score', v_p.trust_score);
end
$$;

-- ================================================================ reports
create or replace function public.admin_list_reports(
  p_search       text default null,
  p_status       text default null,
  p_category     text default null,
  p_include_spam boolean default true,
  p_limit        int default 50,
  p_offset       int default 0
)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v jsonb;
begin
  perform public.admin_guard();

  with base as (
    select r.*, p.display_name as reporter_name, u.email::text as reporter_email, p.trust_score as reporter_trust,
           p.role as reporter_role, coalesce(u.is_anonymous, false) as reporter_anonymous
    from public.reports r
    left join public.profiles p on p.id = r.reporter_id
    left join auth.users u on u.id = r.reporter_id
    where (coalesce(p_include_spam, true) or not r.is_spam)
      and (p_status is null or p_status = '' or p_status = 'all'
           or (p_status = 'spam' and r.is_spam)
           or r.status::text = p_status)
      and (p_category is null or p_category = '' or p_category = 'all' or r.category::text = p_category)
      and (v_q is null
           or r.title_en ilike '%' || v_q || '%'
           or r.title_ur ilike '%' || v_q || '%'
           or r.summary_en ilike '%' || v_q || '%'
           or r.transcript ilike '%' || v_q || '%'
           or r.address_text ilike '%' || v_q || '%'
           or p.display_name ilike '%' || v_q || '%'
           or u.email ilike '%' || v_q || '%'
           or r.id::text ilike v_q || '%'
           or r.cluster_id::text ilike v_q || '%')
  ),
  page as (
    select * from base
    order by created_at desc, id
    limit least(greatest(coalesce(p_limit, 50), 1), 500) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id,
        'created_at', b.created_at,
        'updated_at', b.updated_at,
        'category', b.category,
        'urgency', b.urgency,
        'status', b.status,
        'title_en', b.title_en,
        'title_ur', b.title_ur,
        'summary_en', b.summary_en,
        'summary_ur', b.summary_ur,
        'transcript', b.transcript,
        'language', b.language,
        'input_modes', to_jsonb(b.input_modes),
        'attributes', b.attributes,
        'conversation', b.conversation,
        'user_urgency', b.user_urgency,
        'confidence', b.confidence,
        'ai_reason', b.ai_reason,
        'ai_provider', b.ai_provider,
        'photo_check', b.photo_check,
        'is_spam', b.is_spam,
        'spam_reason', b.spam_reason,
        'is_private', b.is_private,
        'address_text', b.address_text,
        'location_source', b.location_source,
        'lat', st_y(b.location::geometry),
        'lng', st_x(b.location::geometry),
        'food_servings', b.food_servings,
        'food_type', b.food_type,
        'safe_until', b.safe_until,
        'cluster_id', b.cluster_id,
        'cluster_status', c.status,
        'cluster_report_count', c.report_count,
        'cluster_confidence', c.confidence,
        'reporter_id', b.reporter_id,
        'reporter_name', b.reporter_name,
        'reporter_email', b.reporter_email,
        'reporter_trust', b.reporter_trust,
        'reporter_role', b.reporter_role,
        'reporter_anonymous', b.reporter_anonymous,
        'media', coalesce((
          select jsonb_agg(jsonb_build_object('type', m.type, 'bucket', m.bucket, 'path', m.storage_path,
                                              'url', case when m.bucket = 'report-images' then public.report_image_url(m.storage_path) end)
                           order by m.created_at, m.id)
          from public.report_media m where m.report_id = b.id), '[]'::jsonb)
      ) order by b.created_at desc, b.id)
      from page b
      left join public.clusters c on c.id = b.cluster_id), '[]'::jsonb))
  into v;
  return v;
end
$$;

create or replace function public.admin_set_cluster_status(p_cluster uuid, p_status public.report_status)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_c public.clusters;
begin
  perform public.admin_guard();
  if p_status is null then
    raise exception 'invalid_status';
  end if;
  update public.clusters set status = p_status where id = p_cluster returning * into v_c;
  if not found then
    raise exception 'cluster_not_found';
  end if;
  update public.reports set status = p_status where cluster_id = p_cluster and not is_spam and status <> p_status;
  v_c := public.recompute_cluster(p_cluster);
  return jsonb_build_object('id', v_c.id, 'status', v_c.status, 'report_count', v_c.report_count, 'confidence', v_c.confidence);
end
$$;

create or replace function public.admin_mark_spam(p_report uuid, p_spam boolean)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_r public.reports;
  v_c public.clusters;
begin
  perform public.admin_guard();
  update public.reports set
    is_spam = coalesce(p_spam, false),
    spam_reason = case when coalesce(p_spam, false) then coalesce(spam_reason, 'admin') else null end
  where id = p_report
  returning * into v_r;
  if not found then
    raise exception 'report_not_found';
  end if;
  if v_r.cluster_id is not null then
    v_c := public.recompute_cluster(v_r.cluster_id);
  end if;
  return jsonb_build_object('id', v_r.id, 'is_spam', v_r.is_spam, 'cluster_id', v_r.cluster_id,
                            'cluster_report_count', v_c.report_count);
end
$$;

-- ================================================================ SOS
create or replace function public.admin_list_sos(p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  perform public.admin_guard();

  with page as (
    select s.*
    from public.sos_sessions s
    order by s.started_at desc, s.id
    limit least(greatest(coalesce(p_limit, 50), 1), 500) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from public.sos_sessions),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'user_id', s.user_id,
        'user_name', p.display_name,
        'user_email', u.email::text,
        'user_phone', coalesce(p.phone, u.phone::text),
        'user_anonymous', coalesce(u.is_anonymous, false),
        'trigger', s.trigger,
        'status', s.status,
        'started_at', s.started_at,
        'ended_at', s.ended_at,
        'alerted_at', s.alerted_at,
        'threat_level', s.threat_level,
        'threat_reason', s.threat_reason,
        'transcript', s.transcript,
        'cluster_id', s.cluster_id,
        'cluster_status', c.status,
        'lat', st_y(s.last_location::geometry),
        'lng', st_x(s.last_location::geometry),
        'last_location_at', s.last_location_at,
        'last_accuracy_m', s.last_accuracy_m,
        'updated_at', s.updated_at,
        'chunks', coalesce((
          select jsonb_agg(jsonb_build_object('seq', k.seq, 'audio_path', k.audio_path, 'transcript', k.transcript,
                                              'threat_level', k.threat_level, 'created_at', k.created_at) order by k.seq)
          from public.sos_chunks k where k.session_id = s.id), '[]'::jsonb),
        'police', coalesce((
          select jsonb_agg(jsonb_build_object('org_id', o.id, 'org_name', o.name, 'org_type', o.org_type, 'status', a.status,
                                              'distance_m', a.distance_m, 'alerted_at', a.alerted_at, 'claimed_at', a.claimed_at,
                                              'in_progress_at', a.in_progress_at, 'resolved_at', a.resolved_at)
                           order by a.alerted_at)
          from public.assignments a join public.organizations o on o.id = a.org_id
          where s.cluster_id is not null and a.cluster_id = s.cluster_id), '[]'::jsonb)
      ) order by s.started_at desc, s.id)
      from page s
      left join public.profiles p on p.id = s.user_id
      left join auth.users u on u.id = s.user_id
      left join public.clusters c on c.id = s.cluster_id), '[]'::jsonb))
  into v;
  return v;
end
$$;

-- ================================================================ assignments
create or replace function public.admin_list_assignments(
  p_status text default null,
  p_limit  int default 200,
  p_offset int default 0
)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  perform public.admin_guard();

  with base as (
    select a.*
    from public.assignments a
    where p_status is null or p_status = '' or p_status = 'all' or a.status::text = p_status
  ),
  page as (
    select * from base
    order by alerted_at desc, id
    limit least(greatest(coalesce(p_limit, 200), 1), 1000) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'status', a.status,
        'distance_m', a.distance_m,
        'note', a.note,
        'alerted_at', a.alerted_at,
        'claimed_at', a.claimed_at,
        'in_progress_at', a.in_progress_at,
        'resolved_at', a.resolved_at,
        'claimed_by_name', cp.display_name,
        'org_id', o.id,
        'org_name', o.name,
        'org_type', o.org_type,
        'cluster_id', c.id,
        'category', c.category,
        'urgency', c.urgency,
        'cluster_status', c.status,
        'title_en', c.title_en,
        'title_ur', c.title_ur,
        'summary_en', c.summary_en,
        'summary_ur', c.summary_ur,
        'report_count', c.report_count,
        'confidence', c.confidence,
        'is_private', c.is_private,
        'sos_session_id', c.sos_session_id,
        'lat', st_y(c.centroid::geometry),
        'lng', st_x(c.centroid::geometry)
      ) order by a.alerted_at desc, a.id)
      from page a
      join public.organizations o on o.id = a.org_id
      join public.clusters c on c.id = a.cluster_id
      left join public.profiles cp on cp.id = a.claimed_by), '[]'::jsonb))
  into v;
  return v;
end
$$;

-- ================================================================ clusters (live map: every pin incl. private SOS)
create or replace function public.admin_list_clusters(p_include_resolved boolean default true)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  perform public.admin_guard();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'category', c.category,
    'urgency', c.urgency,
    'status', c.status,
    'lat', st_y(c.centroid::geometry),
    'lng', st_x(c.centroid::geometry),
    'report_count', c.report_count,
    'reporter_count', c.reporter_count,
    'confirm_count', c.confirm_count,
    'dispute_count', c.dispute_count,
    'confidence', c.confidence,
    'ai_reason', c.ai_reason,
    'title_en', c.title_en,
    'title_ur', c.title_ur,
    'summary_en', c.summary_en,
    'summary_ur', c.summary_ur,
    'photo_url', public.report_image_url(c.photo_path),
    'attributes', c.attributes,
    'user_urgency', c.user_urgency,
    'is_private', c.is_private,
    'sos_session_id', c.sos_session_id,
    'claimed_org_name', c.claimed_org_name,
    'created_at', c.created_at,
    'updated_at', c.updated_at,
    'last_report_at', c.last_report_at
  ) order by c.updated_at desc), '[]'::jsonb)
  into v
  from public.clusters c
  where coalesce(p_include_resolved, true) or c.status <> 'resolved';
  return v;
end
$$;

-- ================================================================ notifications
create or replace function public.admin_list_notifications(
  p_type   text default null,
  p_limit  int default 100,
  p_offset int default 0
)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  perform public.admin_guard();

  with base as (
    select n.*
    from public.notifications n
    where p_type is null or p_type = '' or p_type = 'all' or n.type = p_type
  ),
  page as (
    select * from base
    order by created_at desc, id
    limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'types', coalesce((select jsonb_object_agg(t.type, t.n)
                       from (select type, count(*) n from public.notifications group by type) t), '{}'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id,
        'type', n.type,
        'created_at', n.created_at,
        'read_at', n.read_at,
        'title_en', n.title_en,
        'title_ur', n.title_ur,
        'body_en', n.body_en,
        'body_ur', n.body_ur,
        'cluster_id', n.cluster_id,
        'report_id', n.report_id,
        'user_id', n.user_id,
        'user_name', p.display_name,
        'user_role', p.role,
        'user_email', u.email::text
      ) order by n.created_at desc, n.id)
      from page n
      left join public.profiles p on p.id = n.user_id
      left join auth.users u on u.id = n.user_id), '[]'::jsonb))
  into v;
  return v;
end
$$;

-- ================================================================ activity feed
create or replace function public.admin_activity(p_limit int default 30)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_lim int := least(greatest(coalesce(p_limit, 30), 1), 200);
  v jsonb;
begin
  perform public.admin_guard();

  with ev as (
    (select 'report'::text as kind, r.created_at as at, r.id as ref_id, r.cluster_id, r.category::text as category,
            r.title_en, r.title_ur, r.status::text as status, null::text as org_name, r.is_private, r.is_spam
     from public.reports r order by r.created_at desc limit v_lim)
    union all
    (select 'assignment_' || a.status::text, coalesce(a.resolved_at, a.in_progress_at, a.claimed_at, a.alerted_at), a.id,
            a.cluster_id, c.category::text, c.title_en, c.title_ur, a.status::text, o.name, c.is_private, false
     from public.assignments a
     join public.clusters c on c.id = a.cluster_id
     join public.organizations o on o.id = a.org_id
     order by coalesce(a.resolved_at, a.in_progress_at, a.claimed_at, a.alerted_at) desc limit v_lim)
    union all
    (select 'sos_' || s.status, coalesce(s.ended_at, s.alerted_at, s.started_at), s.id, s.cluster_id, 'safety',
            null, null, s.threat_level, null, true, false
     from public.sos_sessions s order by coalesce(s.ended_at, s.alerted_at, s.started_at) desc limit v_lim)
    union all
    (select 'org_pending', o.created_at, o.id, null, o.org_type::text,
            null, null, null, o.name, false, false
     from public.organizations o where not o.approved order by o.created_at desc limit v_lim)
  )
  select coalesce(jsonb_agg(to_jsonb(e) order by e.at desc), '[]'::jsonb)
  into v
  from (select * from ev order by at desc limit v_lim) e;
  return v;
end
$$;

-- ================================================================ storage: admins read report-audio (signed URLs)
drop policy if exists "awaaz report-audio admin select" on storage.objects;
create policy "awaaz report-audio admin select" on storage.objects
  for select to authenticated
  using (bucket_id = 'report-audio' and (select public.is_admin()));

-- ================================================================ grants
revoke execute on function
  public.admin_area_of(text),
  public.admin_guard(),
  public.admin_overview(),
  public.admin_list_users(text, text, int, int),
  public.admin_set_role(uuid, public.user_role),
  public.admin_set_trust(uuid, real),
  public.admin_list_reports(text, text, text, boolean, int, int),
  public.admin_set_cluster_status(uuid, public.report_status),
  public.admin_mark_spam(uuid, boolean),
  public.admin_list_sos(int, int),
  public.admin_list_assignments(text, int, int),
  public.admin_list_clusters(boolean),
  public.admin_list_notifications(text, int, int),
  public.admin_activity(int)
from public, anon;

grant execute on function
  public.admin_area_of(text),
  public.admin_guard(),
  public.admin_overview(),
  public.admin_list_users(text, text, int, int),
  public.admin_set_role(uuid, public.user_role),
  public.admin_set_trust(uuid, real),
  public.admin_list_reports(text, text, text, boolean, int, int),
  public.admin_set_cluster_status(uuid, public.report_status),
  public.admin_mark_spam(uuid, boolean),
  public.admin_list_sos(int, int),
  public.admin_list_assignments(text, int, int),
  public.admin_list_clusters(boolean),
  public.admin_list_notifications(text, int, int),
  public.admin_activity(int)
to authenticated, service_role;

notify pgrst, 'reload schema';
