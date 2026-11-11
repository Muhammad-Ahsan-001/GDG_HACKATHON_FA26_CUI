-- Awaaz: realtime (postgres_changes; RLS decides what each subscriber receives).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

alter publication supabase_realtime add table
  public.clusters, public.assignments, public.notifications, public.reports;

alter table public.clusters    replica identity full;
alter table public.assignments replica identity full;

notify pgrst, 'reload schema';
