-- ============================================================
-- Canvas in-app assistant — separate threads  (migration 0042, see ADR-0007)
-- ============================================================
-- 0041 gave each (deck, user) ONE flat assistant conversation: the Claude
-- (Agent SDK) session id lived on the latest assistant message, and "Clear"
-- deleted the whole history. This splits that single stream into THREADS so a
-- user can start a fresh conversation per task — clean context, cheaper, far
-- less stale-context clobber — without losing the older ones.
--
--   • canvas_assistant_thread is the conversation; canvas_assistant_message
--     gains a thread_id pinning every prompt/reply to one thread.
--   • The Claude session id moves from the message to the THREAD: resuming a
--     thread continues ITS conversation, independent of the user's others.
--   • The web UI creates a thread (the first prompt sets its title) under RLS;
--     the bridge writes replies + the session id through the service role, as
--     before. Canvas still runs zero inference (ADR-0006).
-- ============================================================

create table if not exists public.canvas_assistant_thread (
  id           uuid primary key default gen_random_uuid(),
  deck_id      uuid not null references public.canvas_deck(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id)  on delete cascade,
  user_id      uuid not null references public.users(id)       on delete cascade,

  -- Auto-derived from the first user prompt (the web UI truncates it). Null
  -- only for the brief window before the first message lands. No rename UI in v1.
  title text,

  -- The Agent SDK session for THIS thread, handed back to the bridge on poll so
  -- the conversation resumes instead of starting cold. Written by the bridge
  -- (service role) on a turn's finish.
  claude_session_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canvas_assistant_thread is
  'One in-app assistant conversation for a (deck, user). Holds the Claude session id. See ADR-0007.';

-- Switcher list: a user's threads for a deck, most-recently-active first.
create index if not exists canvas_assistant_thread_deck_user_idx
  on public.canvas_assistant_thread (deck_id, user_id, updated_at desc);

-- updated_at maintenance (mirrors canvas_assistant_message).
create or replace function public.canvas_assistant_thread_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.canvas_assistant_thread_touch() from public, anon, authenticated;

drop trigger if exists canvas_assistant_thread_touch_trg on public.canvas_assistant_thread;
create trigger canvas_assistant_thread_touch_trg
  before update on public.canvas_assistant_thread
  for each row execute function public.canvas_assistant_thread_touch();

-- ------------------------------------------------------------
-- Link messages to threads.
-- ------------------------------------------------------------
alter table public.canvas_assistant_message
  add column if not exists thread_id uuid references public.canvas_assistant_thread(id) on delete cascade;

-- Backfill: one thread per existing (deck, user), titled from its first prompt
-- and seeded with that conversation's latest session id; then point every
-- message at it. (deck_id, user_id) is unique per group, so the join is 1:1.
--
-- Idempotency: this whole block runs only while the message-level
-- claude_session_id column still exists — i.e. on the first run, before the
-- drop below. On a re-run that column is gone (dropped at the end of the prior
-- run) and the backfill is skipped entirely. It must be skipped, not merely
-- no-op'd: the seed subquery references claude_session_id, and Postgres plans
-- the statement (validating that column) before executing, so a plain re-run
-- would error on the dropped column even with a thread_id-is-null guard. Wrapping
-- it in EXECUTE defers parsing to runtime, inside the column-exists guard. The
-- guard's grp CTE is still scoped to thread_id-is-null rows so a same-run retry
-- can't create duplicate threads. Same semantics on first run, safe to re-run.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'canvas_assistant_message'
      and column_name = 'claude_session_id'
  ) then
    execute $backfill$
      with grp as (
        select deck_id, user_id, workspace_id, min(created_at) as first_at
        from public.canvas_assistant_message
        where thread_id is null
        group by deck_id, user_id, workspace_id
      ),
      ins as (
        insert into public.canvas_assistant_thread
          (deck_id, workspace_id, user_id, title, claude_session_id, created_at, updated_at)
        select
          g.deck_id, g.workspace_id, g.user_id,
          left((
            select m.content from public.canvas_assistant_message m
            where m.deck_id = g.deck_id and m.user_id = g.user_id and m.role = 'user'
            order by m.created_at asc limit 1
          ), 80),
          (
            select m.claude_session_id from public.canvas_assistant_message m
            where m.deck_id = g.deck_id and m.user_id = g.user_id
              and m.role = 'assistant' and m.claude_session_id is not null
            order by m.created_at desc limit 1
          ),
          g.first_at, now()
        from grp g
        returning id, deck_id, user_id
      )
      update public.canvas_assistant_message msg
      set thread_id = ins.id
      from ins
      where msg.deck_id = ins.deck_id and msg.user_id = ins.user_id;
    $backfill$;
  end if;
end
$$;

alter table public.canvas_assistant_message
  alter column thread_id set not null;

-- Thread reads (hydrate + realtime ordering within one thread).
create index if not exists canvas_assistant_message_thread_idx
  on public.canvas_assistant_message (thread_id, created_at);

-- The per-(deck,user) session lookup is gone — the session lives on the thread
-- now. Drop the old partial index and the column it served.
drop index if exists public.canvas_assistant_message_session_idx;
alter table public.canvas_assistant_message drop column if exists claude_session_id;

-- Keep the switcher's "most-recently-active" order honest: bump the parent
-- thread's updated_at whenever a message is inserted (a queued prompt, or the
-- bridge opening an assistant row). Deltas are UPDATEs and don't fire this, so
-- a long stream doesn't thrash the index — one bump per turn each side.
create or replace function public.canvas_assistant_thread_bump()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.canvas_assistant_thread
  set updated_at = now()
  where id = new.thread_id;
  return new;
end;
$$;

revoke execute on function public.canvas_assistant_thread_bump() from public, anon, authenticated;

drop trigger if exists canvas_assistant_message_bump_thread_trg on public.canvas_assistant_message;
create trigger canvas_assistant_message_bump_thread_trg
  after insert on public.canvas_assistant_message
  for each row execute function public.canvas_assistant_thread_bump();

-- ============================================================
-- RLS — a user's own threads, private per (deck, user).
-- The bridge does NOT use these policies: it writes through the service-role
-- client after resolving the MCP token (same pattern as /api/mcp/[token]).
-- ============================================================

alter table public.canvas_assistant_thread enable row level security;

-- Read your own threads only — never anyone else's, even within the workspace.
drop policy if exists "users read own assistant threads" on public.canvas_assistant_thread;
create policy "users read own assistant threads"
  on public.canvas_assistant_thread for select
  to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
  );

-- The web UI creates a thread when the user starts a conversation. Only for
-- themselves, only on a deck they can read (mirrors the prompt-insert gate).
drop policy if exists "users create own assistant threads" on public.canvas_assistant_thread;
create policy "users create own assistant threads"
  on public.canvas_assistant_thread for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
    and public.canvas_can_read_deck(deck_id)
  );

-- Delete a whole conversation (cascades its messages). This is the new "clear"
-- — scoped to one thread instead of 0041's blow-away-everything delete.
drop policy if exists "users delete own assistant threads" on public.canvas_assistant_thread;
create policy "users delete own assistant threads"
  on public.canvas_assistant_thread for delete
  to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
  );

-- No UPDATE policy for authenticated: the title is set at insert, and the
-- session id / updated_at are written by the bridge (service role) and the
-- triggers above. (Matches 0041's "no UPDATE for authenticated" stance.)

-- ------------------------------------------------------------
-- Tighten the prompt-insert policy: a prompt must land in a thread the user
-- owns on the SAME deck — defense in depth on top of the existing user_id gate,
-- so a crafted insert can't drop a prompt into someone else's thread.
-- ------------------------------------------------------------
drop policy if exists "users queue own prompts" on public.canvas_assistant_message;
create policy "users queue own prompts"
  on public.canvas_assistant_message for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and user_id = auth.uid()
    and role = 'user'
    and status = 'queued'
    and public.canvas_can_read_deck(deck_id)
    and exists (
      select 1 from public.canvas_assistant_thread t
      where t.id = thread_id
        and t.user_id = auth.uid()
        and t.deck_id = canvas_assistant_message.deck_id
    )
  );

-- ============================================================
-- Realtime — broadcast thread inserts/updates/deletes to the switcher.
-- (Per-deck/per-user filtering happens client-side; RLS gates payloads.)
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'canvas_assistant_thread'
  ) then
    alter publication supabase_realtime add table public.canvas_assistant_thread;
  end if;
end
$$;
