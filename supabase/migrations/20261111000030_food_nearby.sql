-- Awaaz Phase 2: food rescue + nearby danger alerts.
--   map_pins              food clusters drop off the public map one hour after their safe_until (stale food offers
--                         are noise and could send people to unsafe food). Recreated from its latest definition in
--                         20261111000010_phase1b.sql: same columns, same order, same security_invoker = false; only the
--                         WHERE clause gains the food-expiry condition. CREATE OR REPLACE keeps owner + grants.
--   nearby_citizen_tokens now LEFT JOINs device_tokens: citizens who shared their location in the last 48 h but never
--                         enabled push (or whose token was pruned) still get the in-app `nearby_alert` row (Realtime
--                         card in the open app). fcm_token is null for them; _shared/notify.ts already skips null
--                         tokens when pushing. Same signature + return type, so grants (service_role only) are kept.

-- ================================================================ map_pins
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
  and not (c.status = 'resolved' and c.updated_at < now() - interval '24 hours')
  and not (c.category = 'food' and c.safe_until is not null and c.safe_until < now() - interval '1 hour');

-- belt and braces: re-assert the read-only grants exactly as in the grants migration
revoke all on table public.map_pins from anon, authenticated, public;
grant select on table public.map_pins to anon, authenticated;
grant all on table public.map_pins to service_role;

-- ================================================================ nearby_citizen_tokens
-- One row per (citizen, device token); a citizen without any token gets one row with fcm_token = null.
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
  left join public.device_tokens t on t.user_id = p.id
  where p.role = 'citizen'
    and p.last_location is not null
    and p.last_location_at > now() - interval '48 hours'
    and st_dwithin(p.last_location, v_pt, greatest(coalesce(p_radius_m, 1000), 0))
    and not (p.id = any (coalesce(p_exclude, '{}'::uuid[])));
end
$$;

revoke execute on function public.nearby_citizen_tokens(float8, float8, float8, uuid[]) from public, anon, authenticated;
grant execute on function public.nearby_citizen_tokens(float8, float8, float8, uuid[]) to service_role;
