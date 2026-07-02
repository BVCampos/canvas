-- ============================================================
-- Canvas in-app assistant — stop / cancel a turn  (migration 0053, see ADR-0008)
-- ============================================================
-- Until now a running assistant turn could only end on its own (finish/error) or
-- hit the bridge's 120s wall-clock timeout — there was no way to STOP it, the way
-- Esc interrupts Claude Code. This adds the two pieces the cancel path needs:
--
--   • cancel_requested_at — the web UI's Stop sets this (service role, via a
--     server action) on the in-flight 'user' row. The local bridge reads it on a
--     short in-turn poll (/api/assistant/bridge/cancel-check) and aborts the
--     running `claude -p`, then reports a 'canceled' turn.
--   • a 'canceled' status — a distinct TERMINAL state (not 'error'), so the
--     chatbox can keep whatever partial output Claude produced and label it
--     "Stopped" rather than flashing a red failure with a Retry-as-error.
--
-- Additive + nullable. No new RLS policy: in-flight rows are mutated only by the
-- service-role path (the bridge today, and now the Stop server action), exactly
-- as 0041/0042 established. Authenticated callers still have no UPDATE policy.
-- The table is already in supabase_realtime, so the canceled settle + the
-- cancel_requested_at flag both broadcast to the chatbox live.
--
-- Deploy note: CI does not run migrations — apply this to prod Supabase BEFORE
-- the new bridge/server code ships, or a 'canceled' write violates the old CHECK.
-- ============================================================

alter table public.canvas_assistant_message
  add column if not exists cancel_requested_at timestamptz;

comment on column public.canvas_assistant_message.cancel_requested_at is
  'Set (service role) when the user hits Stop on a running turn. The local bridge '
  'polls this via /api/assistant/bridge/cancel-check and aborts. NULL = no stop '
  'requested. See migration 0053 / ADR-0008.';

-- Widen the status state machine with the new terminal 'canceled'. The original
-- constraint (0041) was created inline, so it carries Postgres's auto-derived
-- name canvas_assistant_message_status_check; drop that and re-add a named one.
--   user rows:      queued -> running   -> complete | error | canceled
--   assistant rows: streaming           -> complete | error | canceled
alter table public.canvas_assistant_message
  drop constraint if exists canvas_assistant_message_status_check;

alter table public.canvas_assistant_message
  add constraint canvas_assistant_message_status_check
  check (status in ('queued', 'running', 'streaming', 'complete', 'error', 'canceled'));

-- Partial index for the bridge's cancel-check lookup: an in-flight prompt with a
-- pending stop request. Tiny, and only the running turn ever probes it.
create index if not exists canvas_assistant_message_cancel_idx
  on public.canvas_assistant_message (id)
  where cancel_requested_at is not null;
