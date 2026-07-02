-- ============================================================
-- Usage event log (migration 0014)
-- ============================================================
-- Append-only telemetry table. One row per instrumented operation
-- across MCP, API routes, server actions, and auth callbacks.
--
-- Writes happen exclusively via the service-role admin client from
-- `app/src/lib/usage/log.ts`. There's no INSERT policy for
-- authenticated users — the table is system-written, user-read.
--
-- Reads are restricted to workspace admins/owners for their own
-- workspace via existing `public.is_workspace_admin_or_owner`. Regular
-- members can't browse the audit trail (we may relax this later).
--
-- deck_id is intentionally a soft reference (no FK). If a deck is
-- deleted, we don't want to lose the history that it ever existed —
-- the usage row is the only place that audit survives.
--
-- Retention: none enforced. Volume is expected to be tiny (a small
-- number of MCP-active users × tens of events/day). Revisit with a
-- pruning cron if this table grows past ~1M rows.
-- ============================================================

create table public.canvas_usage_event (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  event        text   not null,
  surface      text   not null check (surface in ('mcp', 'api', 'action', 'auth')),
  status       text   not null check (status in ('ok', 'error', 'denied')),
  user_id      uuid   references auth.users(id) on delete set null,
  workspace_id uuid   references public.workspaces(id) on delete cascade,
  deck_id      uuid,
  slide_id     uuid,
  duration_ms  integer,
  error_code   text,
  props        jsonb  not null default '{}'::jsonb
);

-- Workspace-scoped time queries ("show last 7 days of events in this workspace").
create index canvas_usage_event_ws_time_idx
  on public.canvas_usage_event (workspace_id, created_at desc);

-- Event-name time queries ("how many mcp.tool_call across the platform last week").
create index canvas_usage_event_event_time_idx
  on public.canvas_usage_event (event, created_at desc);

-- Per-user activity. Partial index — many rows will have null user_id
-- (e.g. mcp.auth_fail with no resolvable user).
create index canvas_usage_event_user_time_idx
  on public.canvas_usage_event (user_id, created_at desc)
  where user_id is not null;

alter table public.canvas_usage_event enable row level security;

-- Read: admins/owners see their own workspace's events. workspace_id
-- can be null on auth.* events (no workspace yet) — those are
-- invisible to everyone except direct service-role queries.
create policy canvas_usage_event_select_admin
  on public.canvas_usage_event for select to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_admin_or_owner(workspace_id)
  );

-- No INSERT/UPDATE/DELETE policies. Service role bypasses RLS for
-- writes; nothing else should mutate this table.
