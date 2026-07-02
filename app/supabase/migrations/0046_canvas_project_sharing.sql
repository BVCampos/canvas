-- ============================================================
-- Project-level sharing — migration 0046
-- ============================================================
-- Makes a Project (0038) a shareable unit, mirroring per-deck sharing
-- (0015 visibility + ACL, 0025 guest access, 0027 public link). Sharing a
-- project reaches EVERY deck in it.
--
-- Model — ADDITIVE / union (never narrows a deck's own access):
--   * canvas_project_member — explicit per-project ACL (viewer | editor),
--     same shape as canvas_deck_member. A project member reaches every deck
--     in the project regardless of the deck's own visibility.
--   * canvas_project.visibility ('workspace' | 'private') — gates who sees the
--     PROJECT ROW/group (workspace = all full members; private = members +
--     admins only). It does NOT itself widen deck CONTENT access — the deck
--     cascade below unions on project MEMBERSHIP only, so merely grouping a
--     private deck under a normal (workspace-visible) project never exposes it.
--   * canvas_project.public_share_token — opt-in "anyone with the link" for the
--     whole project, resolved by the service-role client (see migration 0027);
--     no anon RLS.
--
-- The cascade is implemented by adding ONE branch to canvas_can_read_deck /
-- canvas_can_edit_deck. Every deck-child table already gates on those two
-- helpers, so slides/comments/assets/versions/snapshots/locks/edits/storage
-- inherit project access automatically — no other RLS rewrites.
--
-- All statements idempotent where possible (IF EXISTS / CREATE OR REPLACE).
-- ============================================================

-- ============================================================
-- 1. Enums  (reuse canvas_deck_visibility for project visibility)
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'canvas_project_member_role') then
    create type public.canvas_project_member_role as enum ('viewer', 'editor');
  end if;
end$$;

-- ============================================================
-- 2. canvas_project columns: visibility + public_share_token
-- ============================================================

alter table public.canvas_project
  add column if not exists visibility public.canvas_deck_visibility
    not null default 'workspace';

alter table public.canvas_project
  add column if not exists public_share_token text;

-- Unguessable, view-only capability token. Partial unique index only indexes
-- shared projects; the /p/project/{token} viewer resolves the project via the
-- service-role client gated solely by an exact match. Mirrors 0027.
create unique index if not exists canvas_project_public_share_token_key
  on public.canvas_project(public_share_token)
  where public_share_token is not null;

comment on column public.canvas_project.public_share_token is
  'Opt-in public view-only share link for the whole project. NULL = not shared. '
  'A non-null value is an unguessable token; /p/project/{token} resolves the '
  'project via the service-role client gated only by an exact match on this '
  'column. Minted/revoked by project editors; never exposed to the anon role.';

-- ============================================================
-- 3. canvas_project_member — explicit per-project ACL
-- ============================================================

create table if not exists public.canvas_project_member (
  project_id   uuid not null references public.canvas_project(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role         public.canvas_project_member_role not null default 'viewer',
  invited_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists canvas_project_member_user_idx
  on public.canvas_project_member(user_id);
create index if not exists canvas_project_member_workspace_idx
  on public.canvas_project_member(workspace_id);
create index if not exists canvas_project_member_project_role_idx
  on public.canvas_project_member(project_id, role);

alter table public.canvas_project_member enable row level security;

-- ============================================================
-- 4. Project-access helper functions
-- ============================================================
-- SECURITY DEFINER so they read canvas_project / canvas_project_member without
-- triggering RLS recursion (those tables' own policies call back into these).
-- Rule mirrors the deck helpers:
--   - workspace admins/owners always pass
--   - an explicit canvas_project_member row grants viewer/editor access
--     (this is the guest path; role gates edit vs read)
--   - a FULL workspace member passes when visibility='workspace'

create or replace function public.canvas_can_read_project(_project_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select exists (
    select 1 from public.canvas_project p
    where p.id = _project_id
      and (
        public.is_workspace_admin_or_owner(p.workspace_id)
        or exists (
          select 1 from public.canvas_project_member pm
          where pm.project_id = p.id
            and pm.user_id = auth.uid()
        )
        or (
          p.visibility = 'workspace'
          and public.is_workspace_member_full(p.workspace_id)
        )
      )
  );
$function$;

create or replace function public.canvas_can_edit_project(_project_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select exists (
    select 1 from public.canvas_project p
    where p.id = _project_id
      and (
        public.is_workspace_admin_or_owner(p.workspace_id)
        or exists (
          select 1 from public.canvas_project_member pm
          where pm.project_id = p.id
            and pm.user_id = auth.uid()
            and pm.role = 'editor'
        )
        or (
          p.visibility = 'workspace'
          and public.is_workspace_member_full(p.workspace_id)
        )
      )
  );
$function$;

revoke execute on function public.canvas_can_read_project(uuid) from public, anon;
revoke execute on function public.canvas_can_edit_project(uuid) from public, anon;
grant execute on function public.canvas_can_read_project(uuid) to authenticated;
grant execute on function public.canvas_can_edit_project(uuid) to authenticated;

-- ============================================================
-- 5. Deck cascade — add the project-member branch to the deck helpers
-- ============================================================
-- Carries the 0025 body forward verbatim and adds ONE OR-branch: an explicit
-- project member reaches every deck in the project. Unions on project
-- MEMBERSHIP only (not the project's workspace-visibility), so grouping a
-- private deck under a normal project never auto-exposes it. CREATE OR REPLACE
-- preserves the existing GRANTs.

create or replace function public.canvas_can_read_deck(_deck_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select exists (
    select 1 from public.canvas_deck d
    where d.id = _deck_id
      and (
        public.is_workspace_admin_or_owner(d.workspace_id)
        or exists (
          select 1 from public.canvas_deck_member m
          where m.deck_id = d.id
            and m.user_id = auth.uid()
        )
        or (
          d.visibility = 'workspace'
          and public.is_workspace_member_full(d.workspace_id)
        )
        -- Project-level sharing (0046): a project member reaches every deck in
        -- the project, regardless of the deck's own visibility. Additive.
        or exists (
          select 1 from public.canvas_project_member pm
          where pm.project_id = d.project_id
            and pm.user_id = auth.uid()
        )
      )
  );
$function$;

create or replace function public.canvas_can_edit_deck(_deck_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select exists (
    select 1 from public.canvas_deck d
    where d.id = _deck_id
      and (
        public.is_workspace_admin_or_owner(d.workspace_id)
        or exists (
          select 1 from public.canvas_deck_member m
          where m.deck_id = d.id
            and m.user_id = auth.uid()
            and m.role = 'editor'
        )
        or (
          d.visibility = 'workspace'
          and public.is_workspace_member_full(d.workspace_id)
        )
        -- Project-level sharing (0046): a project EDITOR can edit every deck in
        -- the project. Viewers fall through to the read helper only.
        or exists (
          select 1 from public.canvas_project_member pm
          where pm.project_id = d.project_id
            and pm.user_id = auth.uid()
            and pm.role = 'editor'
        )
      )
  );
$function$;

-- ============================================================
-- 6. canvas_project_member RLS  (mirror of canvas_deck_member, 0015 §6)
-- ============================================================

drop policy if exists "users read own project memberships and editors read all" on public.canvas_project_member;
create policy "users read own project memberships and editors read all"
  on public.canvas_project_member for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_project(project_id)
  );

drop policy if exists "editors and admins add project members" on public.canvas_project_member;
create policy "editors and admins add project members"
  on public.canvas_project_member for insert
  to authenticated
  with check (
    (public.is_workspace_admin_or_owner(workspace_id) or public.canvas_can_edit_project(project_id))
    and exists (
      select 1 from public.workspace_memberships wm
      where wm.workspace_id = canvas_project_member.workspace_id
        and wm.user_id      = canvas_project_member.user_id
    )
  );

drop policy if exists "editors and admins update project members" on public.canvas_project_member;
create policy "editors and admins update project members"
  on public.canvas_project_member for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_project(project_id)
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_project(project_id)
  );

drop policy if exists "editors admins or self remove project members" on public.canvas_project_member;
create policy "editors admins or self remove project members"
  on public.canvas_project_member for delete
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_admin_or_owner(workspace_id)
    or public.canvas_can_edit_project(project_id)
  );

-- ============================================================
-- 7. canvas_project policy rewrites (0038 → access-aware)
-- ============================================================
-- SELECT moves to canvas_can_read_project so project members (incl. guests)
-- see the project group. UPDATE adds the project-editor branch so editors can
-- rename / flip visibility / mint the public link. INSERT and DELETE are
-- unchanged from 0038 (full members create; creator-or-admin delete).

drop policy if exists "full members read projects"   on public.canvas_project;
drop policy if exists "users with access read projects" on public.canvas_project;
create policy "users with access read projects"
  on public.canvas_project for select
  to authenticated
  using (public.canvas_can_read_project(id));

drop policy if exists "creators and admins update projects" on public.canvas_project;
drop policy if exists "editors and admins update projects"  on public.canvas_project;
create policy "editors and admins update projects"
  on public.canvas_project for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or created_by = (select auth.uid())
    or exists (
      select 1 from public.canvas_project_member pm
      where pm.project_id = id and pm.user_id = (select auth.uid()) and pm.role = 'editor'
    )
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or created_by = (select auth.uid())
    or exists (
      select 1 from public.canvas_project_member pm
      where pm.project_id = id and pm.user_id = (select auth.uid()) and pm.role = 'editor'
    )
  );

-- ============================================================
-- 8. Triggers  (mirror of 0015 §5)
-- ============================================================

-- 8a. On insert of a private project, auto-add the creator as an editor.
create or replace function public.canvas_project_init_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility = 'private' and new.created_by is not null then
    insert into public.canvas_project_member (project_id, user_id, workspace_id, role, invited_by)
    values (new.id, new.created_by, new.workspace_id, 'editor', new.created_by)
    on conflict (project_id, user_id) do nothing;
  end if;
  return null;
end;
$$;

revoke execute on function public.canvas_project_init_member() from public, anon, authenticated;

drop trigger if exists canvas_project_init_member_trg on public.canvas_project;
create trigger canvas_project_init_member_trg
  after insert on public.canvas_project
  for each row execute function public.canvas_project_init_member();

-- 8b. When a project is flipped to private, guarantee the creator an editor seat.
create or replace function public.canvas_project_visibility_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.visibility = 'private'
     and old.visibility is distinct from 'private'
     and new.created_by is not null then
    insert into public.canvas_project_member (project_id, user_id, workspace_id, role, invited_by)
    values (new.id, new.created_by, new.workspace_id, 'editor', new.created_by)
    on conflict (project_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.canvas_project_visibility_change() from public, anon, authenticated;

drop trigger if exists canvas_project_visibility_change_trg on public.canvas_project;
create trigger canvas_project_visibility_change_trg
  after update of visibility on public.canvas_project
  for each row execute function public.canvas_project_visibility_change();

-- 8c. Extend the membership-removal cleanup (0015 §5c) to also drop the user's
-- project memberships when they're removed from the workspace — same reasoning
-- as the deck-member cleanup it already does.
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
  delete from public.canvas_project_member
   where user_id      = old.user_id
     and workspace_id = old.workspace_id;
  return old;
end;
$$;

-- ============================================================
-- 9. workspace_invites: optional per-project scope (mirror of 0025 §4 / 0026)
-- ============================================================
-- When project_id/project_role are set, accepting the invite also grants a
-- canvas_project_member row on that project. A guest invite must be scoped to
-- a deck OR a project (otherwise the guest reaches nothing).

alter table public.workspace_invites
  add column if not exists project_id uuid references public.canvas_project(id) on delete cascade,
  add column if not exists project_role public.canvas_project_member_role;

alter table public.workspace_invites
  drop constraint if exists workspace_invites_project_scope_chk;
alter table public.workspace_invites
  add constraint workspace_invites_project_scope_chk
    check (
      (project_id is null and project_role is null)
      or (project_id is not null and project_role is not null)
    );

-- An invite is scoped to a deck OR a project, never both.
alter table public.workspace_invites
  drop constraint if exists workspace_invites_single_scope_chk;
alter table public.workspace_invites
  add constraint workspace_invites_single_scope_chk
    check (deck_id is null or project_id is null);

-- A guest invite must carry a deck OR project scope (relaxes the 0025
-- deck-only requirement).
alter table public.workspace_invites
  drop constraint if exists workspace_invites_guest_requires_deck_chk;
alter table public.workspace_invites
  add constraint workspace_invites_guest_requires_scope_chk
    check (role <> 'guest'::public.workspace_role or deck_id is not null or project_id is not null);

-- Uniqueness by scope (extends 0026). A project-scoped invite has deck_id NULL,
-- so the workspace-invite index must also exclude project-scoped rows, else a
-- project guest invite would collide with a workspace member invite.
drop index if exists public.workspace_invites_unique_pending_workspace;
create unique index if not exists workspace_invites_unique_pending_workspace
  on public.workspace_invites (workspace_id, lower(email))
  where accepted_at is null and deck_id is null and project_id is null;

create unique index if not exists workspace_invites_unique_pending_project
  on public.workspace_invites (workspace_id, lower(email), project_id)
  where accepted_at is null and project_id is not null;

create index if not exists workspace_invites_project_idx
  on public.workspace_invites(project_id) where project_id is not null;
