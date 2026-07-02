-- ============================================================
-- Canvas in-app assistant — migration 0041  (see ADR-0006)
-- ============================================================
-- The web chatbox and the local `canvas-agent` bridge talk through one table.
--
--   • The web UI inserts the user's message (role='user', status='queued') as
--     the authenticated user, under RLS.
--   • The bridge — running on the user's own machine, authenticated to Canvas
--     with that user's MCP token — polls /api/assistant/bridge/poll, claims the
--     queued rows (service role, RLS bypassed), runs `claude -p` locally under
--     the user's OWN Claude subscription, and streams the answer back by
--     inserting/patching assistant rows (role='assistant') via
--     /api/assistant/bridge/event (service role).
--   • The web UI renders the conversation live via Supabase Realtime; RLS scopes
--     each user to their own messages (their own rows only, never anyone else's).
--     (Multiple named conversations per deck arrive in 0042; 0041 itself just
--     scopes messages to the (deck, user) pair.)
--
-- Canvas runs zero inference and never holds a Claude credential — see ADR-0006
-- for why the subscription path has to execute locally (Anthropic's terms forbid
-- using a user's subscription token server-side in a product).
-- ============================================================

create table if not exists public.canvas_assistant_message (
  id           uuid primary key default gen_random_uuid(),
  deck_id      uuid not null references public.canvas_deck(id)  on delete cascade,
  workspace_id uuid not null references public.workspaces(id)   on delete cascade,
  user_id      uuid not null references public.users(id)        on delete cascade,

  -- 'user'      : a prompt typed in the web chatbox.
  -- 'assistant' : the local bridge's reply (possibly streamed in place).
  role text not null check (role in ('user', 'assistant')),

  content text not null default '',

  -- user rows:      queued -> running (claimed by bridge) -> complete | error
  -- assistant rows: streaming (being appended) -> complete | error
  status text not null
    check (status in ('queued', 'running', 'streaming', 'complete', 'error')),

  -- On assistant rows: the Agent SDK session id, handed back to the bridge on
  -- the next poll so the conversation resumes instead of starting cold.
  claude_session_id text,

  -- Populated on status='error' (a short, user-safe message).
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canvas_assistant_message is
  'In-app assistant messages. User prompts + local-bridge replies, scoped per (deck, user). Threading (named conversations) is added in 0042. See ADR-0006/0007.';

-- Thread reads (web UI hydrate + realtime ordering).
create index if not exists canvas_assistant_message_deck_user_idx
  on public.canvas_assistant_message (deck_id, user_id, created_at);

-- The bridge claim: cheap lookup of unstarted prompts across the user's decks.
create index if not exists canvas_assistant_message_queued_idx
  on public.canvas_assistant_message (workspace_id, user_id, created_at)
  where role = 'user' and status = 'queued';

-- Resume pointer lookup: latest assistant session for a (deck, user).
create index if not exists canvas_assistant_message_session_idx
  on public.canvas_assistant_message (deck_id, user_id, created_at desc)
  where role = 'assistant' and claude_session_id is not null;

-- updated_at maintenance (mirrors other canvas_* tables).
create or replace function public.canvas_assistant_message_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.canvas_assistant_message_touch() from public, anon, authenticated;

drop trigger if exists canvas_assistant_message_touch_trg on public.canvas_assistant_message;
create trigger canvas_assistant_message_touch_trg
  before update on public.canvas_assistant_message
  for each row execute function public.canvas_assistant_message_touch();

-- ============================================================
-- RLS — each user sees only their own messages, scoped per (deck, user).
-- (Named conversations land in 0042; here the scope is just the (deck, user)
-- pair.) The bridge does NOT use these policies: it writes through the
-- service-role client after resolving the MCP token (same pattern as
-- /api/mcp/[token]).
-- ============================================================

alter table public.canvas_assistant_message enable row level security;

-- Read your own messages only — never anyone else's, even within the workspace.
drop policy if exists "users read own assistant messages" on public.canvas_assistant_message;
create policy "users read own assistant messages"
  on public.canvas_assistant_message for select
  to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
  );

-- The web chatbox inserts user prompts. Assistant rows are written by the
-- bridge (service role), so authenticated callers may only insert queued
-- 'user' rows for themselves.
drop policy if exists "users queue own prompts" on public.canvas_assistant_message;
create policy "users queue own prompts"
  on public.canvas_assistant_message for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
    and role = 'user'
    and status = 'queued'
    -- deck-readability gate: can't queue a prompt against a deck you can't read
    -- (e.g. a guest scoped to other decks), even though it lands among your own messages.
    and public.canvas_can_read_deck(deck_id)
  );

-- "Clear conversation" — a user can delete their own messages.
drop policy if exists "users clear own assistant messages" on public.canvas_assistant_message;
create policy "users clear own assistant messages"
  on public.canvas_assistant_message for delete
  to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
  );

-- No UPDATE policy for authenticated: in-flight rows are mutated only by the
-- bridge (service role). RLS still authorizes Realtime broadcast against the
-- SELECT policy above, so each user receives only their own messages' events.

-- ============================================================
-- Realtime — broadcast inserts/updates to the web chatbox.
-- (Per-deck/per-user filtering happens client-side; RLS gates payloads.)
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'canvas_assistant_message'
  ) then
    alter publication supabase_realtime add table public.canvas_assistant_message;
  end if;
end
$$;
