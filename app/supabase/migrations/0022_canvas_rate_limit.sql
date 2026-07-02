-- ============================================================
-- Abuse control: DB-backed fixed-window rate limiter (migration 0022)
-- ============================================================
-- The token-authenticated MCP endpoint and the import endpoint are public-
-- internet surfaces with no throttle. A proper edge limiter (Upstash / Vercel
-- WAF) is the eventual home, but this gives a real, no-extra-infra backstop
-- using the Postgres we already have: an atomic increment-and-check against a
-- per-bucket counter for the current time window.
--
-- The counter table is service-role-only (RLS on, no policies) and the function
-- is SECURITY DEFINER granted ONLY to service_role — the API routes call it via
-- the admin client, and authenticated/anon can neither read the table nor call
-- the function (so it can't be used to grief the counters).
-- ============================================================

create table if not exists public.canvas_rate_limit (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

alter table public.canvas_rate_limit enable row level security;
-- No policies on purpose: only the service role (admin client) touches this.

-- Returns true if the request is ALLOWED (count within _max for the current
-- window), false if it should be throttled. Prunes stale windows for the bucket
-- on each call so the table stays bounded without a cron.
create or replace function public.canvas_rate_limit_hit(
  _bucket text,
  _max integer,
  _window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / _window_seconds) * _window_seconds
  );
  v_count integer;
begin
  delete from public.canvas_rate_limit
   where bucket = _bucket and window_start < v_window;

  insert into public.canvas_rate_limit (bucket, window_start, count)
  values (_bucket, v_window, 1)
  on conflict (bucket, window_start)
  do update set count = public.canvas_rate_limit.count + 1
  returning count into v_count;

  return v_count <= _max;
end;
$$;

revoke all on function public.canvas_rate_limit_hit(text, integer, integer) from public, authenticated, anon;
grant execute on function public.canvas_rate_limit_hit(text, integer, integer) to service_role;
