-- Awaaz: helper functions + triggers.

-- ---------------------------------------------------------------- helpers used by RLS / views
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public, extensions
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.my_role()
returns public.user_role
language sql stable security definer
set search_path = public, extensions
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.my_org_ids()
returns uuid[]
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(array_agg(o.id), '{}'::uuid[]) from public.organizations o where o.owner_id = auth.uid();
$$;

-- Full public URL of an object in the public report-images bucket (used by the views).
create or replace function public.report_image_url(p_path text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_path is null or btrim(p_path) = '' then null
    when p_path ~* '^https?://' then p_path
    else 'https://sossfezffxvargkzuyvc.supabase.co/storage/v1/object/public/report-images/'
         || regexp_replace(ltrim(p_path, '/'), '^report-images/', '')
  end;
$$;

-- ---------------------------------------------------------------- updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger clusters_set_updated_at before update on public.clusters
  for each row execute function public.set_updated_at();
create trigger reports_set_updated_at before update on public.reports
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- profile on signup
-- role comes from raw_user_meta_data->>'role' only when it is citizen|ngo|responder. NEVER admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role public.user_role := 'citizen';
  v_lang text := 'ur';
  v_name text;
begin
  if (v_meta ->> 'role') in ('citizen', 'ngo', 'responder') then
    v_role := (v_meta ->> 'role')::public.user_role;
  end if;
  if (v_meta ->> 'language') in ('ur', 'en') then
    v_lang := v_meta ->> 'language';
  end if;
  v_name := nullif(btrim(coalesce(v_meta ->> 'display_name', v_meta ->> 'full_name', v_meta ->> 'name', '')), '');

  insert into public.profiles (id, role, display_name, language)
  values (new.id, v_role, left(v_name, 80), v_lang)
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- protect privileged profile columns
-- Clients (anon / authenticated) can never change role, trust_score, is_demo (or id / created_at).
-- Security-definer RPCs (owned by postgres) and the service role can.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin') then
    return new;
  end if;
  new.id          := old.id;
  new.role        := old.role;
  new.trust_score := old.trust_score;
  new.is_demo     := old.is_demo;
  new.created_at  := old.created_at;
  return new;
end
$$;

create trigger profiles_protect_columns before update on public.profiles
  for each row execute function public.protect_profile_columns();

-- ---------------------------------------------------------------- organisations: fill service_area
-- Centre + radius form: service_area = ST_Buffer(center, radius_m). An explicit polygon is kept as given.
create or replace function public.organizations_fill_service_area()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.service_area is null then
      new.radius_m := coalesce(new.radius_m, 5000);
      new.service_area := st_buffer(new.center, new.radius_m::float8);
    end if;
  else
    if new.service_area is null then
      new.radius_m := coalesce(new.radius_m, old.radius_m, 5000);
      new.service_area := st_buffer(new.center, new.radius_m::float8);
    elsif new.radius_m is not null
      and (new.radius_m is distinct from old.radius_m or st_asbinary(new.center) <> st_asbinary(old.center))
      and st_asbinary(new.service_area) = st_asbinary(old.service_area) then
      -- centre/radius changed but the polygon was not explicitly replaced: re-buffer
      new.service_area := st_buffer(new.center, new.radius_m::float8);
    end if;
  end if;
  return new;
end
$$;

create trigger organizations_fill_service_area before insert or update on public.organizations
  for each row execute function public.organizations_fill_service_area();
