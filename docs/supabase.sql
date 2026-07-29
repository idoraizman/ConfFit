-- ConfFit — Supabase schema.
-- Run once in the Supabase SQL editor for the project.
--
-- The app connects with the service-role key from the server only; no browser
-- ever talks to these tables, so RLS stays on with no public policies.

-- Cached ConferenceProfile per venue. The biggest cross-run saving: a venue
-- already in here costs zero LLM calls in ConferenceProfiler.
create table if not exists public.conference_profiles (
  venue_id    text primary key,
  venue       text not null,
  profile     jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Human-in-the-loop gate. One row per (session, venue) awaiting a "yes".
-- Keyed on venue as well as session so a bare {"prompt":"yes"} with no
-- session_id can still be resolved.
create table if not exists public.pending_approvals (
  session_id  text not null,
  venue_id    text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, venue_id)
);

create index if not exists pending_approvals_venue_idx
  on public.pending_approvals (venue_id, created_at desc);

-- Run history: what was asked, for which venue, and what it cost.
create table if not exists public.runs (
  id          bigint generated always as identity primary key,
  session_id  text,
  venue_id    text,
  task        text,
  usage       jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists runs_created_idx on public.runs (created_at desc);

alter table public.conference_profiles enable row level security;
alter table public.pending_approvals   enable row level security;
alter table public.runs                enable row level security;

-- Housekeeping: an approval nobody answered is stale after a day.
-- Schedule with pg_cron if you want it automatic, or run it by hand.
-- delete from public.pending_approvals where created_at < now() - interval '1 day';
