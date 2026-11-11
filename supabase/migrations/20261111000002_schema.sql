-- Awaaz: enums, tables, indexes (docs/CONTRACT.md §1).
-- PostGIS / pgvector live in schema "extensions", so their types are schema-qualified here.

-- ---------------------------------------------------------------- enums
create type public.user_role         as enum ('citizen', 'ngo', 'responder', 'admin');
create type public.org_type          as enum ('shelter', 'food_bank', 'health_ngo', 'rescue_1122', 'fire', 'police', 'water');
create type public.report_category   as enum ('hazard', 'fire', 'flood', 'water', 'food', 'health', 'safety', 'other');
create type public.urgency_level     as enum ('low', 'medium', 'high', 'critical');
create type public.report_status     as enum ('unconfirmed', 'verified', 'disputed', 'in_progress', 'resolved');
create type public.vote_type         as enum ('confirm', 'dispute');
create type public.assignment_status as enum ('alerted', 'claimed', 'in_progress', 'resolved');
create type public.media_type        as enum ('audio', 'image');

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  role             public.user_role not null default 'citizen',
  display_name     text,
  phone            text,
  language         text not null default 'ur' check (language in ('ur', 'en')),
  trust_score      real not null default 0.5 check (trust_score >= 0 and trust_score <= 1),
  last_location    extensions.geography(Point, 4326),
  last_location_at timestamptz,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index profiles_role_idx on public.profiles (role);
create index profiles_last_location_gix on public.profiles using gist (last_location);

-- ---------------------------------------------------------------- organizations
create table public.organizations (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 2 and 160),
  org_type     public.org_type not null,
  categories   public.report_category[] not null default '{}',
  center       extensions.geography(Point, 4326) not null,
  radius_m     integer check (radius_m is null or radius_m between 50 and 200000),
  -- always filled: a BEFORE trigger buffers center by radius_m when it is not given
  service_area extensions.geography(Polygon, 4326) not null,
  phone        text,
  approved     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index organizations_owner_idx on public.organizations (owner_id);
create index organizations_service_area_gix on public.organizations using gist (service_area);
create index organizations_center_gix on public.organizations using gist (center);

-- ---------------------------------------------------------------- clusters (one map pin each)
create table public.clusters (
  id                 uuid primary key default gen_random_uuid(),
  category           public.report_category not null,
  urgency            public.urgency_level not null default 'medium',
  centroid           extensions.geography(Point, 4326) not null,
  report_count       int not null default 0,
  reporter_count     int not null default 0,
  confirm_count      int not null default 0,
  dispute_count      int not null default 0,
  photo_match_count  int not null default 0,
  confidence         real not null default 0,
  ai_reason          text,
  status             public.report_status not null default 'unconfirmed',
  summary_en         text,
  summary_ur         text,
  title_en           text,
  title_ur           text,
  primary_report_id  uuid,                -- fk added below (reports created after clusters)
  photo_path         text,                -- path inside the public report-images bucket
  food_servings      int,
  food_type          text,
  safe_until         timestamptz,
  claimed_org_id     uuid references public.organizations (id) on delete set null,
  claimed_org_name   text,
  routed_at          timestamptz,
  nearby_notified_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_report_at     timestamptz not null default now()
);
create index clusters_centroid_gix on public.clusters using gist (centroid);
create index clusters_status_idx on public.clusters (status);
create index clusters_category_created_idx on public.clusters (category, created_at desc);
create index clusters_updated_idx on public.clusters (updated_at desc);

-- ---------------------------------------------------------------- reports
create table public.reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null references public.profiles (id) on delete cascade,
  client_id       text not null,
  cluster_id      uuid references public.clusters (id) on delete set null,
  category        public.report_category not null default 'other',
  urgency         public.urgency_level not null default 'medium',
  title_en        text,
  title_ur        text,
  summary_ur      text,
  summary_en      text,
  canonical_en    text,
  transcript      text,
  language        text,                                  -- ur | pa | en | mixed
  input_modes     text[] not null default '{}'
                  check (input_modes <@ array['voice', 'photo', 'text']::text[]),
  embedding       extensions.vector(1536),
  embedding_model text,
  location        extensions.geography(Point, 4326) not null,
  location_source text,                                  -- gps | map | geocoded | fallback
  address_text    text,
  location_hints  text[],
  status          public.report_status not null default 'unconfirmed',
  confidence      real not null default 0,
  ai_reason       text,
  is_spam         boolean not null default false,
  spam_reason     text,
  photo_check     jsonb,
  extraction      jsonb,
  ai_provider     text,
  food_servings   int,
  food_type       text,
  safe_until      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint reports_reporter_client_key unique (reporter_id, client_id)
);
create index reports_embedding_hnsw on public.reports using hnsw (embedding extensions.vector_cosine_ops);
create index reports_location_gix on public.reports using gist (location);
create index reports_category_created_idx on public.reports (category, created_at);
create index reports_cluster_idx on public.reports (cluster_id);
create index reports_reporter_idx on public.reports (reporter_id, created_at desc);

alter table public.clusters
  add constraint clusters_primary_report_fk
  foreign key (primary_report_id) references public.reports (id) on delete set null;

-- ---------------------------------------------------------------- report_media
create table public.report_media (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references public.reports (id) on delete cascade,
  type         public.media_type not null,
  storage_path text not null,
  bucket       text not null,
  created_at   timestamptz not null default now()
);
create index report_media_report_idx on public.report_media (report_id);

-- ---------------------------------------------------------------- report_votes
create table public.report_votes (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid not null references public.reports (id) on delete cascade,
  cluster_id uuid not null references public.clusters (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  vote       public.vote_type not null,
  created_at timestamptz not null default now(),
  constraint report_votes_report_user_key unique (report_id, user_id)
);
create index report_votes_cluster_idx on public.report_votes (cluster_id);
create index report_votes_user_idx on public.report_votes (user_id);

-- ---------------------------------------------------------------- assignments
create table public.assignments (
  id             uuid primary key default gen_random_uuid(),
  cluster_id     uuid not null references public.clusters (id) on delete cascade,
  report_id      uuid references public.reports (id) on delete set null,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  status         public.assignment_status not null default 'alerted',
  distance_m     real,
  note           text,
  alerted_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  claimed_by     uuid references public.profiles (id) on delete set null,
  in_progress_at timestamptz,
  resolved_at    timestamptz,
  constraint assignments_cluster_org_key unique (cluster_id, org_id)
);
create index assignments_org_status_idx on public.assignments (org_id, status);
create index assignments_cluster_idx on public.assignments (cluster_id);

-- ---------------------------------------------------------------- device_tokens
create table public.device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  fcm_token    text not null unique,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index device_tokens_user_idx on public.device_tokens (user_id);

-- ---------------------------------------------------------------- notifications
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  report_id  uuid,
  cluster_id uuid,
  type       text not null,   -- new_assignment | status_change | nearby_alert | food_alert | verified
  title_en   text,
  title_ur   text,
  body_en    text,
  body_ur    text,
  data       jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
