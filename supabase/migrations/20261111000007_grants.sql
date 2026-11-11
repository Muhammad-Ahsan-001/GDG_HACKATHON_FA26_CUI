-- Awaaz: explicit privileges (the project default grants everything to anon/authenticated; tighten it).

-- ---------------------------------------------------------------- tables
revoke all on table
  public.profiles, public.organizations, public.clusters, public.reports, public.report_media,
  public.report_votes, public.assignments, public.device_tokens, public.notifications
from anon, authenticated, public;

grant all on table
  public.profiles, public.organizations, public.clusters, public.reports, public.report_media,
  public.report_votes, public.assignments, public.device_tokens, public.notifications
to service_role;

grant select on table public.clusters to anon, authenticated;

grant select on table
  public.profiles, public.organizations, public.reports, public.report_media,
  public.report_votes, public.assignments, public.notifications, public.device_tokens
to authenticated;

-- own profile: only these columns are client-writable (role / trust_score / is_demo are not)
grant update (display_name, phone, language, last_location, last_location_at) on table public.profiles to authenticated;
-- own device tokens: full CRUD (RLS restricts to own rows)
grant insert, update, delete on table public.device_tokens to authenticated;
-- own notifications: mark as read only
grant update (read_at) on table public.notifications to authenticated;

-- ---------------------------------------------------------------- views (read-only; they bypass table RLS)
revoke all on table public.map_pins, public.public_reports, public.org_directory, public.my_assignments
from anon, authenticated, public;
grant select on table public.map_pins, public.public_reports, public.org_directory to anon, authenticated;
grant select on table public.my_assignments to authenticated;
grant all on table public.map_pins, public.public_reports, public.org_directory, public.my_assignments to service_role;

-- ---------------------------------------------------------------- functions
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- helpers referenced by RLS policies and views (must be executable by the querying role)
grant execute on function
  public.is_admin(), public.my_role(), public.my_org_ids(), public.report_image_url(text)
to anon, authenticated;

-- user RPCs
grant execute on function
  public.cast_vote(uuid, public.vote_type),
  public.set_my_role(public.user_role),
  public.update_my_location(float8, float8),
  public.register_organization(text, public.org_type, public.report_category[], float8, float8, int, text, json),
  public.approve_organization(uuid, boolean),
  public.apply_assignment_action(uuid, text, text),
  public.dashboard_stats(uuid),
  public.register_device_token(text, text)
to authenticated;

-- match_cluster, recompute_cluster, find_responders, nearby_citizen_tokens: service_role only (granted above).
