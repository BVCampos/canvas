-- Explicit lock attribution replaces the old provider/email heuristic. The
-- persisted `agent` value covers every MCP client; existing rows are human by
-- default and expire within 15 minutes anyway.

alter table public.canvas_deck_slide_lock
  add column if not exists locked_by_kind text not null default 'user'
    check (locked_by_kind in ('user', 'agent'));

comment on column public.canvas_deck_slide_lock.locked_by_kind is
  'Whether this lock was acquired in the Canvas UI or through any MCP agent.';

