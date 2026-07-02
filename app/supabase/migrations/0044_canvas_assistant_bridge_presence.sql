-- ============================================================
-- Canvas in-app assistant — bridge presence  (migration 0044, ADR-0006)
-- ============================================================
-- The chatbox needs a local `canvas-agent` bridge running to answer prompts.
-- Until now "is my assistant up?" was only answerable after a ~12s stall (the
-- chatbox's offline hint fires when an in-flight turn goes quiet). This adds a
-- heartbeat so the panel can show a presence indicator BEFORE you send: the
-- bridge polls /api/assistant/bridge/poll every ~2.5s, and that endpoint stamps
-- a per-user last_seen here. The panel reads it (own row, realtime) and shows
-- "online" when last_seen is recent.
--
-- One row per user (the bridge runs once per machine and polls across all the
-- user's decks). Written by the poll endpoint via the service role; readable by
-- the user themselves under RLS. Ships WITH the assistant code.
-- ============================================================

create table if not exists public.canvas_assistant_bridge_presence (
  user_id      uuid primary key references public.users(id)      on delete cascade,
  -- The workspace of the token the bridge last polled with — attribution only.
  workspace_id uuid references public.workspaces(id) on delete set null,
  last_seen_at timestamptz not null default now()
);

comment on table public.canvas_assistant_bridge_presence is
  'Heartbeat for a user''s local canvas-agent bridge: last_seen_at is bumped on every /api/assistant/bridge/poll so the chatbox can show a presence dot. See ADR-0006.';

alter table public.canvas_assistant_bridge_presence enable row level security;

-- Read your own presence only. No insert/update/delete policy for authenticated:
-- the heartbeat is written by the poll endpoint through the service role (same
-- pattern as the rest of the bridge tables).
create policy "users read own bridge presence"
  on public.canvas_assistant_bridge_presence for select
  to authenticated
  using (user_id = auth.uid());

-- Realtime — broadcast the heartbeat to the user's own open panel.
-- (RLS gates the payload to the user's own row.)
alter publication supabase_realtime add table public.canvas_assistant_bridge_presence;
