-- ============================================================
-- In-app @mention notification feed — migration 0048
-- ============================================================
-- @mentions in comments have been parsed + stored on canvas_comment.mentions
-- since the web comment path resolved handles against workspace members, but
-- they were never DELIVERED: no table, no badge, no feed. A mentioned teammate
-- had no way to find out. This adds a per-user, in-app (no email) notification
-- feed.
--
-- Model:
--   * canvas_notification — one row per (recipient, event). Written ONLY by the
--     server-side logger via the service-role client (same pattern as
--     canvas_usage_event in 0014 and the assistant bridge writes): there is no
--     client INSERT policy. A user reads + marks-read their OWN rows.
--   * kind enum 'mention' | 'comment_reply' — a comment that @-mentions you, or
--     a reply to a thread you authored.
--   * FKs cascade to the parents (workspace / deck / slide / comment / users)
--     so deleting any of them cleans up the notifications that point at it —
--     no orphan rows linking into a deleted deck.
--
-- Realtime: the table joins supabase_realtime (guarded do-$$ block, mirrors
-- 0042) so the topbar badge can live-update. Per-recipient filtering happens
-- client-side (filter user_id=eq.<me>); RLS still scopes payloads to the
-- recipient's own rows.
-- ============================================================

-- ------------------------------------------------------------
-- 1. kind enum
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'canvas_notification_kind') then
    create type public.canvas_notification_kind as enum ('mention', 'comment_reply');
  end if;
end$$;

-- ------------------------------------------------------------
-- 2. Table
-- ------------------------------------------------------------
create table if not exists public.canvas_notification (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The recipient. Indexed + RLS-scoped on this column.
  user_id      uuid not null references public.users(id) on delete cascade,
  -- Who caused the notification (the comment author). Nullable + ON DELETE SET
  -- NULL so removing a user doesn't erase their teammates' notification trail;
  -- the feed just renders "Someone" for a null actor.
  actor_id     uuid references public.users(id) on delete set null,
  kind         public.canvas_notification_kind not null,
  -- Where it points. All soft-nullable so the feed degrades gracefully, but
  -- FK'd (cascade) so a deleted deck/slide/comment takes its notifications
  -- with it rather than leaving dangling links.
  deck_id      uuid references public.canvas_deck(id) on delete cascade,
  slide_id     uuid references public.canvas_deck_slide(id) on delete cascade,
  comment_id   uuid references public.canvas_comment(id) on delete cascade,
  -- A short, single-lined snippet of the comment body so the feed renders
  -- without a join back to canvas_comment (which may already be deleted).
  body_preview text,
  -- NULL while unread; stamped when the user opens / marks it read.
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.canvas_notification is
  'Per-user in-app notification feed (mentions + comment replies). Written '
  'server-side via the service role; users read + mark-read their own rows. '
  'See migration 0048.';

-- Feed query: a user's notifications, newest first.
create index if not exists canvas_notification_user_idx
  on public.canvas_notification (user_id, created_at desc);

-- Badge query: count a user's unread. Partial index so it stays small (only
-- the unread rows) and the count is a cheap index-only scan.
create index if not exists canvas_notification_unread_idx
  on public.canvas_notification (user_id)
  where read_at is null;

-- ------------------------------------------------------------
-- 3. RLS — a user sees + marks-read only their OWN rows.
-- No INSERT/DELETE policies: rows are written by the service-role logger
-- (which bypasses RLS) and removed only by the FK cascades above.
-- ------------------------------------------------------------
alter table public.canvas_notification enable row level security;

drop policy if exists "users read own notifications" on public.canvas_notification;
create policy "users read own notifications"
  on public.canvas_notification for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Mark-read is the only mutation a user may make, and only on their own rows.
-- The WITH CHECK keeps the row theirs (a crafted update can't reassign it to
-- someone else); it does NOT constrain which columns change, but the only
-- client write path (markNotificationsRead) sets read_at.
drop policy if exists "users update own notifications" on public.canvas_notification;
create policy "users update own notifications"
  on public.canvas_notification for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 4. Realtime — broadcast inserts/updates so the badge live-updates.
-- Per-recipient filtering is client-side; RLS gates the payloads to the
-- recipient. Guarded add so a re-run doesn't error on "already in publication".
-- (Same pattern as 0042.)
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'canvas_notification'
  ) then
    alter publication supabase_realtime add table public.canvas_notification;
  end if;
end
$$;
