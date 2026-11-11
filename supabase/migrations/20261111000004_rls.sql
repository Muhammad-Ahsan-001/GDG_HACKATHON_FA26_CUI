-- Awaaz: Row Level Security on every table. All writes not listed here go through
-- security-definer RPCs or Edge Functions (service role bypasses RLS).

alter table public.profiles      enable row level security;
alter table public.organizations enable row level security;
alter table public.clusters      enable row level security;
alter table public.reports       enable row level security;
alter table public.report_media  enable row level security;
alter table public.report_votes  enable row level security;
alter table public.assignments   enable row level security;
alter table public.device_tokens enable row level security;
alter table public.notifications enable row level security;

-- profiles: own row; admin sees all. Update own row (privileged columns protected by trigger + column grants).
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- organizations: approved ones are public; owners and admins also see unapproved. Writes via RPC.
create policy organizations_select on public.organizations
  for select to anon, authenticated
  using (approved or owner_id = (select auth.uid()) or (select public.is_admin()));

-- clusters: public map data (no identities inside). Writes: service role only.
create policy clusters_select on public.clusters
  for select to anon, authenticated
  using (true);

-- reports: own, admin, or a member org that has an assignment for the report's cluster.
create policy reports_select on public.reports
  for select to authenticated
  using (
    reporter_id = (select auth.uid())
    or (select public.is_admin())
    or (
      cluster_id is not null
      and exists (
        select 1 from public.assignments a
        where a.cluster_id = reports.cluster_id
          and a.org_id in (select unnest(public.my_org_ids()))
      )
    )
  );

-- report_media: visible when the parent report is visible (reports RLS applies inside the subquery).
create policy report_media_select on public.report_media
  for select to authenticated
  using (exists (select 1 from public.reports r where r.id = report_media.report_id));

-- report_votes: own votes only; writes via cast_vote().
create policy report_votes_select_own on public.report_votes
  for select to authenticated
  using (user_id = (select auth.uid()));

-- assignments: org owner or admin; updates via apply_assignment_action().
create policy assignments_select on public.assignments
  for select to authenticated
  using (org_id in (select unnest(public.my_org_ids())) or (select public.is_admin()));

-- device_tokens: full CRUD on own rows.
create policy device_tokens_select_own on public.device_tokens
  for select to authenticated using (user_id = (select auth.uid()));
create policy device_tokens_insert_own on public.device_tokens
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy device_tokens_update_own on public.device_tokens
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy device_tokens_delete_own on public.device_tokens
  for delete to authenticated using (user_id = (select auth.uid()));

-- notifications: select own; update own (column grant restricts it to read_at).
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy notifications_update_own on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
