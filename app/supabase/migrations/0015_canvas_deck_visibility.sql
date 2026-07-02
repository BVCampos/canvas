-- ============================================================
-- Canvas per-deck visibility & sharing — migration 0015
-- ============================================================
-- Adds:
--   1. canvas_deck.visibility ('workspace' | 'private') — default
--      'workspace' so every existing deck keeps its current behaviour.
--   2. canvas_deck_member — explicit per-deck ACL (deck_id, user_id,
--      role 'viewer'|'editor'). Workspace-id is denormalised on each
--      row for RLS fast-path.
--   3. Helper fns canvas_can_read_deck / canvas_can_edit_deck. These
--      encapsulate the new rule everywhere:
--        - workspace admin/owner always passes
--        - workspace member passes when visibility='workspace'
--        - explicit canvas_deck_member rows grant viewer/editor access
--          (still requires active workspace membership, so dropping a
--           user from the workspace also drops their deck access)
--   4. Trigger on canvas_deck INSERT (and visibility flip to private)
--      that auto-adds the creator as an editor.
--   5. Trigger on workspace_memberships DELETE that nukes any
--      canvas_deck_member rows for the removed user — mirrors the
--      canvas_mcp_token cleanup in 0007.
--   6. RLS rewrites across every deck-child table so visibility
--      actually gates reads and writes — canvas_deck, canvas_deck_slide,
--      canvas_deck_slide_lock, canvas_deck_edit, canvas_deck_asset,
--      canvas_deck_source, canvas_comment, canvas_slide_version,
--      canvas_deck_snapshot, canvas_deck_snapshot_slide, and the
--      storage policies on the `decks` bucket.
--
-- All statements are idempotent where possible (DROP IF EXISTS /
-- CREATE OR REPLACE).
-- ============================================================

-- ============================================================
-- 1. Enums
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'canvas_deck_visibility') then
    create type public.canvas_deck_visibility as enum ('workspace', 'private');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'canvas_deck_member_role') then
    create type public.canvas_deck_member_role as enum ('viewer', 'editor');
  end if;
end$$;

-- ============================================================
-- 2. canvas_deck.visibility column
-- ============================================================

alter table public.canvas_deck
  add column if not exists visibility public.canvas_deck_visibility
    not null default 'workspace';

create index if not exists canvas_deck_visibility_idx
  on public.canvas_deck(workspace_id, visibility);

-- ============================================================
-- 3. canvas_deck_member — explicit per-deck ACL
-- ============================================================

create table if not exists public.canvas_deck_member (
  deck_id      uuid not null references public.canvas_deck(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role         public.canvas_deck_member_role not null default 'viewer',
  invited_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (deck_id, user_id)
);

create index if not exists canvas_deck_member_user_idx
  on public.canvas_deck_member(user_id);
create index if not exists canvas_deck_member_workspace_idx
  on public.canvas_deck_member(workspace_id);
create index if not exists canvas_deck_member_deck_role_idx
  on public.canvas_deck_member(deck_id, role);

alter table public.canvas_deck_member enable row level security;

-- ============================================================
-- 4. Helper functions
-- ============================================================
-- Both helpers are SECURITY DEFINER so they can read canvas_deck and
-- canvas_deck_member without triggering RLS recursion (those tables'
-- own SELECT policies call these helpers). They still use auth.uid()
-- to evaluate the rule against the calling user.
--
-- Rule:
--   - workspace admins/owners always pass
--   - otherwise, the user must be an active workspace member AND
--       (a) the deck's visibility is 'workspace', OR
--       (b) the user has a canvas_deck_member row on this deck
--           (role gates edit vs read)
-- Removing someone from workspace_memberships kills both paths.

create or replace function public.canvas_can_read_deck(_deck_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.canvas_deck d
    where d.id = _deck_id
      and (
        public.is_workspace_admin_or_owner(d.workspace_id)
        or (
          public.is_workspace_member(d.workspace_id)
          and (
            d.visibility = 'workspace'
            or exists (
              select 1 from public.canvas_deck_member m
              where m.deck_id = d.id and m.user_id = auth.uid()
            )
          )
        )
      )
  );
$$;

create or replace function public.canvas_can_edit_deck(_deck_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.canvas_deck d
    where d.id = _deck_id
      and (
        public.is_workspace_admin_or_owner(d.workspace_id)
        or (
          public.is_workspace_member(d.workspace_id)
          and (
            d.visibility = 'workspace'
            or exists (
              select 1 from public.canvas_deck_member m
              where m.deck_id = d.id
                and m.user_id = auth.uid()
                and m.role = 'editor'
            )
          )
        )
      )
  );
$$;

revoke execute on function public.canvas_can_read_deck(uuid) from public, anon;
revoke execute on function public.canvas_can_edit_deck(uuid) from public, anon;
grant execute on function public.canvas_can_read_deck(uuid) to authenticated;
grant execute on function public.canvas_can_edit_deck(uuid) to authenticated;

-- ============================================================
-- 5. Triggers
-- ============================================================

-- 5a. On insert of a private deck, auto-add the creator as an editor.
create or replace function public.canvas_deck_init_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility = 'private' and new.created_by is not null then
    insert into public.canvas_deck_member (deck_id, user_id, workspace_id, role, invited_by)
    values (new.id, new.created_by, new.workspace_id, 'editor', new.created_by)
    on conflict (deck_id, user_id) do nothing;
  end if;
  return null;
end;
$$;

revoke execute on function public.canvas_deck_init_member() from public, anon, authenticated;

drop trigger if exists canvas_deck_init_member_trg on public.canvas_deck;
create trigger canvas_deck_init_member_trg
  after insert on public.canvas_deck
  for each row execute function public.canvas_deck_init_member();

-- 5b. When a deck is flipped from workspace → private, the creator
-- still gets a guaranteed editor seat (in case they removed everyone
-- else first). Flipping back to workspace doesn't drop the members:
-- they're harmless and one click flips visibility back, so we keep
-- them so the share list isn't lost on accidental toggles.
create or replace function public.canvas_deck_visibility_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility = 'private'
     and old.visibility is distinct from 'private'
     and new.created_by is not null then
    insert into public.canvas_deck_member (deck_id, user_id, workspace_id, role, invited_by)
    values (new.id, new.created_by, new.workspace_id, 'editor', new.created_by)
    on conflict (deck_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.canvas_deck_visibility_change() from public, anon, authenticated;

drop trigger if exists canvas_deck_visibility_change_trg on public.canvas_deck;
create trigger canvas_deck_visibility_change_trg
  after update of visibility on public.canvas_deck
  for each row execute function public.canvas_deck_visibility_change();

-- 5c. When a workspace_memberships row is removed, drop every deck
-- membership the user has in that workspace. Mirrors the MCP token
-- cleanup in 0007 — ON DELETE CASCADE on users(id) is the nuclear
-- option (full account deletion), this catches the common case of
-- removing someone from a single workspace.
create or replace function public.canvas_revoke_deck_members_on_membership_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.canvas_deck_member
   where user_id      = old.user_id
     and workspace_id = old.workspace_id;
  return old;
end;
$$;

revoke execute on function public.canvas_revoke_deck_members_on_membership_removal() from public, anon, authenticated;

drop trigger if exists canvas_revoke_deck_members_on_membership_removal_trg on public.workspace_memberships;
create trigger canvas_revoke_deck_members_on_membership_removal_trg
  after delete on public.workspace_memberships
  for each row
  execute function public.canvas_revoke_deck_members_on_membership_removal();

-- ============================================================
-- 6. canvas_deck_member RLS
-- ============================================================

drop policy if exists "users read own deck memberships and editors read all" on public.canvas_deck_member;
create policy "users read own deck memberships and editors read all"
  on public.canvas_deck_member for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_deck(deck_id)
  );

drop policy if exists "editors and admins add deck members" on public.canvas_deck_member;
create policy "editors and admins add deck members"
  on public.canvas_deck_member for insert
  to authenticated
  with check (
    -- caller must be admin or a deck editor
    (public.is_workspace_admin_or_owner(workspace_id) or public.canvas_can_edit_deck(deck_id))
    -- and the invited user must also be a workspace member
    and exists (
      select 1 from public.workspace_memberships wm
      where wm.workspace_id = canvas_deck_member.workspace_id
        and wm.user_id      = canvas_deck_member.user_id
    )
  );

drop policy if exists "editors and admins update deck members" on public.canvas_deck_member;
create policy "editors and admins update deck members"
  on public.canvas_deck_member for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_deck(deck_id)
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_deck(deck_id)
  );

drop policy if exists "editors admins or self remove deck members" on public.canvas_deck_member;
create policy "editors admins or self remove deck members"
  on public.canvas_deck_member for delete
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_deck(deck_id)
  );

-- ============================================================
-- 7. RLS rewrites — canvas_deck
-- ============================================================
-- INSERT stays the same (workspace member creating own row).
-- DELETE stays the same (creator or admin).
-- SELECT and UPDATE move to the new helpers.

drop policy if exists "members read canvas decks"           on public.canvas_deck;
drop policy if exists "users with access read decks"        on public.canvas_deck;
create policy "users with access read decks"
  on public.canvas_deck for select
  to authenticated
  using (public.canvas_can_read_deck(id));

drop policy if exists "creators and admins update canvas decks" on public.canvas_deck;
drop policy if exists "editors and admins update decks"        on public.canvas_deck;
create policy "editors and admins update decks"
  on public.canvas_deck for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or created_by = auth.uid()
    or exists (
      select 1 from public.canvas_deck_member m
      where m.deck_id = id and m.user_id = auth.uid() and m.role = 'editor'
    )
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or created_by = auth.uid()
    or exists (
      select 1 from public.canvas_deck_member m
      where m.deck_id = id and m.user_id = auth.uid() and m.role = 'editor'
    )
  );

-- ============================================================
-- 8. RLS rewrites — canvas_deck_slide
-- ============================================================

drop policy if exists "members read slides"            on public.canvas_deck_slide;
drop policy if exists "users with access read slides"  on public.canvas_deck_slide;
create policy "users with access read slides"
  on public.canvas_deck_slide for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members create slides"          on public.canvas_deck_slide;
drop policy if exists "editors create slides"          on public.canvas_deck_slide;
create policy "editors create slides"
  on public.canvas_deck_slide for insert
  to authenticated
  with check (public.canvas_can_edit_deck(deck_id));

drop policy if exists "slide owners and admins update slides"   on public.canvas_deck_slide;
drop policy if exists "slide owners and editors update slides"  on public.canvas_deck_slide;
create policy "slide owners and editors update slides"
  on public.canvas_deck_slide for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (
      public.canvas_can_edit_deck(deck_id)
      and (owner_id is null or owner_id = auth.uid() or created_by = auth.uid())
    )
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (
      public.canvas_can_edit_deck(deck_id)
      and (owner_id is null or owner_id = auth.uid() or created_by = auth.uid())
    )
  );

drop policy if exists "creators and admins delete slides" on public.canvas_deck_slide;
create policy "creators and admins delete slides"
  on public.canvas_deck_slide for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.canvas_can_edit_deck(deck_id) and created_by = auth.uid())
  );

-- ============================================================
-- 9. RLS rewrites — canvas_deck_slide_lock
-- ============================================================
-- update/delete already gate on `locked_by = auth.uid() or admin`, so
-- they don't need rewriting. SELECT and INSERT do.

drop policy if exists "members read locks"            on public.canvas_deck_slide_lock;
drop policy if exists "users with access read locks"  on public.canvas_deck_slide_lock;
create policy "users with access read locks"
  on public.canvas_deck_slide_lock for select
  to authenticated
  using (
    exists (
      select 1 from public.canvas_deck_slide s
      where s.id = slide_id and public.canvas_can_read_deck(s.deck_id)
    )
  );

drop policy if exists "members acquire own locks"     on public.canvas_deck_slide_lock;
drop policy if exists "editors acquire own locks"     on public.canvas_deck_slide_lock;
create policy "editors acquire own locks"
  on public.canvas_deck_slide_lock for insert
  to authenticated
  with check (
    locked_by = auth.uid()
    and exists (
      select 1 from public.canvas_deck_slide s
      where s.id = slide_id and public.canvas_can_edit_deck(s.deck_id)
    )
  );

-- ============================================================
-- 10. RLS rewrites — canvas_deck_edit
-- ============================================================
-- Immutability trigger from 0007 stays in place.

drop policy if exists "members read edits"           on public.canvas_deck_edit;
drop policy if exists "users with access read edits" on public.canvas_deck_edit;
create policy "users with access read edits"
  on public.canvas_deck_edit for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members propose edits"  on public.canvas_deck_edit;
drop policy if exists "editors propose edits"  on public.canvas_deck_edit;
create policy "editors propose edits"
  on public.canvas_deck_edit for insert
  to authenticated
  with check (
    public.canvas_can_edit_deck(deck_id)
    and proposed_by = auth.uid()
  );

drop policy if exists "members resolve edits"  on public.canvas_deck_edit;
drop policy if exists "editors resolve edits"  on public.canvas_deck_edit;
create policy "editors resolve edits"
  on public.canvas_deck_edit for update
  to authenticated
  using (public.canvas_can_edit_deck(deck_id))
  with check (public.canvas_can_edit_deck(deck_id));

-- ============================================================
-- 11. RLS rewrites — canvas_deck_asset
-- ============================================================

drop policy if exists "members read assets"            on public.canvas_deck_asset;
drop policy if exists "users with access read assets"  on public.canvas_deck_asset;
create policy "users with access read assets"
  on public.canvas_deck_asset for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members create assets"  on public.canvas_deck_asset;
drop policy if exists "editors create assets"  on public.canvas_deck_asset;
create policy "editors create assets"
  on public.canvas_deck_asset for insert
  to authenticated
  with check (public.canvas_can_edit_deck(deck_id));

-- admin-only delete policy already enforces is_workspace_admin_or_owner — keep as is.

-- ============================================================
-- 12. RLS rewrites — canvas_deck_source
-- ============================================================

drop policy if exists "members read sources"           on public.canvas_deck_source;
drop policy if exists "users with access read sources" on public.canvas_deck_source;
create policy "users with access read sources"
  on public.canvas_deck_source for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members create sources"  on public.canvas_deck_source;
drop policy if exists "editors create sources"  on public.canvas_deck_source;
create policy "editors create sources"
  on public.canvas_deck_source for insert
  to authenticated
  with check (public.canvas_can_edit_deck(deck_id));

drop policy if exists "creators and admins delete sources" on public.canvas_deck_source;
create policy "creators and admins delete sources"
  on public.canvas_deck_source for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.canvas_can_edit_deck(deck_id) and created_by = auth.uid())
  );

-- ============================================================
-- 13. RLS rewrites — canvas_comment
-- ============================================================
-- Anyone with read access can leave a comment; gating commenting to
-- editors would break the "Viewer can comment" mental model that
-- mirrors Google Docs / Notion.

drop policy if exists "members read comments"            on public.canvas_comment;
drop policy if exists "users with access read comments"  on public.canvas_comment;
create policy "users with access read comments"
  on public.canvas_comment for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members create their own comments" on public.canvas_comment;
drop policy if exists "deck members comment"              on public.canvas_comment;
create policy "deck members comment"
  on public.canvas_comment for insert
  to authenticated
  with check (
    public.canvas_can_read_deck(deck_id)
    and author_id = auth.uid()
    and author_kind = 'user'
  );

drop policy if exists "authors and admins update comments" on public.canvas_comment;
create policy "authors and admins update comments"
  on public.canvas_comment for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.canvas_can_read_deck(deck_id) and author_id = auth.uid())
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.canvas_can_read_deck(deck_id) and author_id = auth.uid())
  );

drop policy if exists "authors and admins delete comments" on public.canvas_comment;
create policy "authors and admins delete comments"
  on public.canvas_comment for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.canvas_can_read_deck(deck_id) and author_id = auth.uid())
  );

-- ============================================================
-- 14. RLS rewrites — canvas_slide_version
-- ============================================================

drop policy if exists "members read slide versions"            on public.canvas_slide_version;
drop policy if exists "users with access read slide versions"  on public.canvas_slide_version;
create policy "users with access read slide versions"
  on public.canvas_slide_version for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members insert slide versions"  on public.canvas_slide_version;
drop policy if exists "editors insert slide versions"  on public.canvas_slide_version;
create policy "editors insert slide versions"
  on public.canvas_slide_version for insert
  to authenticated
  with check (public.canvas_can_edit_deck(deck_id));

-- ============================================================
-- 15. RLS rewrites — canvas_deck_snapshot
-- ============================================================

drop policy if exists "members read snapshots"            on public.canvas_deck_snapshot;
drop policy if exists "users with access read snapshots"  on public.canvas_deck_snapshot;
create policy "users with access read snapshots"
  on public.canvas_deck_snapshot for select
  to authenticated
  using (public.canvas_can_read_deck(deck_id));

drop policy if exists "members create snapshots"  on public.canvas_deck_snapshot;
drop policy if exists "editors create snapshots"  on public.canvas_deck_snapshot;
create policy "editors create snapshots"
  on public.canvas_deck_snapshot for insert
  to authenticated
  with check (public.canvas_can_edit_deck(deck_id));

-- admins delete snapshots policy unchanged.

-- ============================================================
-- 16. RLS rewrites — canvas_deck_snapshot_slide
-- ============================================================

drop policy if exists "members read snapshot slides"            on public.canvas_deck_snapshot_slide;
drop policy if exists "users with access read snapshot slides"  on public.canvas_deck_snapshot_slide;
create policy "users with access read snapshot slides"
  on public.canvas_deck_snapshot_slide for select
  to authenticated
  using (
    exists (
      select 1 from public.canvas_deck_snapshot s
      where s.id = snapshot_id and public.canvas_can_read_deck(s.deck_id)
    )
  );

drop policy if exists "members create snapshot slides"  on public.canvas_deck_snapshot_slide;
drop policy if exists "editors create snapshot slides"  on public.canvas_deck_snapshot_slide;
create policy "editors create snapshot slides"
  on public.canvas_deck_snapshot_slide for insert
  to authenticated
  with check (
    exists (
      select 1 from public.canvas_deck_snapshot s
      where s.id = snapshot_id and public.canvas_can_edit_deck(s.deck_id)
    )
  );

-- ============================================================
-- 17. Storage policies — `decks` bucket
-- ============================================================
-- Path is {workspace_id}/{deck_id}/{asset_id}.{ext}. Read access
-- gates on canvas_can_read_deck; uploads gate on canvas_can_edit_deck.
-- Admin-only delete stays as is.

drop policy if exists "members read deck assets"            on storage.objects;
drop policy if exists "users with access read deck assets"  on storage.objects;
create policy "users with access read deck assets"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'decks'
    and public.canvas_can_read_deck(((storage.foldername(name))[2])::uuid)
  );

drop policy if exists "members upload deck assets"  on storage.objects;
drop policy if exists "editors upload deck assets"  on storage.objects;
create policy "editors upload deck assets"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'decks'
    and public.canvas_can_edit_deck(((storage.foldername(name))[2])::uuid)
  );

-- "admins delete deck assets" policy from 0003 stays.
