-- Forgexus account system — v1.0 (P1/P2 of ROADMAP.md).
--
-- Entitlements and usage-metering schema for the Music Tag Cleaner (and,
-- later, Media Fetch) account system. Run this once the Supabase project
-- from Phase 0 exists — either `supabase db push` via the CLI, or paste
-- into the project's SQL editor.
--
-- Every write to these tables goes through the Edge Functions using the
-- service-role key; the desktop app's own client only ever reads its own
-- rows (enforced below by Row Level Security), so a compromised or
-- reverse-engineered anon key can't grant itself a paid tier.

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'pro', 'studio', 'lifetime')),
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  paddle_subscription_id text,
  paddle_customer_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.entitlements is
  'One row per account. Written only by the paddle-webhook Edge Function
   (subscription lifecycle events) — never by the desktop client directly.';

-- One row per account per day, so "10 tracks/day" resets naturally at
-- midnight UTC without a scheduled job. lifetime_tracks_used is a running
-- total across every row, used for the one-time "3,000 tracks free" grant.
create table if not exists public.usage_counters (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  cloud_tracks_used integer not null default 0,
  lifetime_tracks_used integer not null default 0,
  primary key (user_id, day)
);

comment on table public.usage_counters is
  'Incremented by usage-confirm only on a successful write, per ROADMAP.md
   P2 — a failed or rejected AI suggestion never costs the user anything.';

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_name text,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.devices is
  '3-activation cap (ROADMAP.md P1) is enforced in the entitlements Edge
   Function at sign-in time, not here — this table is just the record.';

alter table public.entitlements enable row level security;
alter table public.usage_counters enable row level security;
alter table public.devices enable row level security;

-- Reads only, and only your own rows. All writes are service-role-only
-- (Edge Functions bypass RLS with that key), so no policy below grants
-- insert/update/delete to the anon/authenticated roles.
create policy "read own entitlements" on public.entitlements
  for select using (auth.uid () = user_id);

create policy "read own usage" on public.usage_counters
  for select using (auth.uid () = user_id);

create policy "read own devices" on public.devices
  for select using (auth.uid () = user_id);

-- Self-service deactivation (ROADMAP.md P1) is the one write a signed-in
-- user makes directly: removing their own device row.
create policy "delete own device" on public.devices
  for delete using (auth.uid () = user_id);
