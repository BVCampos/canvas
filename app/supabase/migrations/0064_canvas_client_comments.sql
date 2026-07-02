-- ============================================================
-- 0064 — client feedback on the public link.
--
-- A recipient of /p/{token} can leave per-slide comments without an
-- account. Their feedback lands in the SAME canvas_comment threads the
-- owner and their agent already read (that loop-back is the whole
-- point — no parallel table), with a third author_kind and client-set
-- attribution columns instead of an auth user.
--
-- Writes never touch RLS: like every other public-surface write, the
-- insert goes through the service-role route, which is where the
-- opt-in flag, rate limits, and validation live. The anon role keeps
-- zero grants on canvas_comment (0027 posture).
-- ============================================================

-- 1. Third author kind. 'client' = an anonymous link visitor; author_id
--    stays NULL (there is no auth.users row to point at).
alter table public.canvas_comment
  drop constraint canvas_comment_author_kind_check;

alter table public.canvas_comment
  add constraint canvas_comment_author_kind_check
  check (author_kind in ('user', 'claude', 'client'));

-- 2. Client attribution. Unverified, client-typed identity — display data,
--    never authorization. The CHECK keeps the partition clean both ways:
--    a client row must carry a name and no user; user/claude rows must not
--    grow name/email fields that would shadow their resolved profile.
alter table public.canvas_comment add column author_name text;
alter table public.canvas_comment add column author_email text;

alter table public.canvas_comment
  add constraint canvas_comment_client_attribution_check
  check (
    (author_kind = 'client'
      and author_name is not null
      and author_id is null)
    or
    (author_kind <> 'client'
      and author_name is null
      and author_email is null)
  );

-- 3. Per-deck opt-in. Off by default; the owner enables commenting where
--    they enable the link (Share dialog). This flag is the primary abuse
--    kill-switch: no flag, no write path.
alter table public.canvas_deck
  add column public_comments_enabled boolean not null default false;

-- 4. Feed kind for "a client left feedback". Same pattern as 0055.
alter type public.canvas_notification_kind
  add value if not exists 'client_comment';
