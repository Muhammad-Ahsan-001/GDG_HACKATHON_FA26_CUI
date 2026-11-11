-- Awaaz: public read views. security_invoker = false (owned by postgres, bypass table RLS);
-- they never expose reporter_id. Grants (select only) are in the grants migration.

-- One row per cluster; clusters resolved more than 24 h ago drop off the map.
create view public.map_pins with (security_invoker = false) as
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
  c.last_report_at
from public.clusters c
where not (c.status = 'resolved' and c.updated_at < now() - interval '24 hours');

-- Non-spam reports (with their cluster) for pin sheets / "Me" page. is_mine = reporter is the caller.
create view public.public_reports with (security_invoker = false) as
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
  coalesce(r.reporter_id = auth.uid(), false) as is_mine
from public.reports r
left join lateral (
  select m.storage_path
  from public.report_media m
  where m.report_id = r.id and m.type = 'image' and m.bucket = 'report-images'
  order by m.created_at, m.id
  limit 1
) img on true
where not r.is_spam
  and r.cluster_id is not null;

-- Approved organisations (+ the caller's own unapproved ones; admins see all).
-- owner_id lets the frontend filter "my organisations".
create view public.org_directory with (security_invoker = false) as
select
  o.id,
  o.name,
  o.org_type,
  o.categories,
  extensions.st_y(o.center::extensions.geometry)::float8 as lat,
  extensions.st_x(o.center::extensions.geometry)::float8 as lng,
  o.radius_m,
  o.approved,
  o.owner_id,
  o.phone,
  o.created_at
from public.organizations o
where o.approved
   or o.owner_id = auth.uid()
   or (select public.is_admin());

-- Assignments of the caller's organisations (admins: all assignments) joined with the cluster pin.
create view public.my_assignments with (security_invoker = false) as
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
  c.last_report_at
from public.assignments a
join public.organizations o on o.id = a.org_id
join public.clusters c on c.id = a.cluster_id
left join public.reports pr on pr.id = c.primary_report_id
where o.owner_id = auth.uid()
   or (select public.is_admin());
