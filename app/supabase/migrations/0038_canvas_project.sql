-- ============================================================
-- Canvas Projects — migration 0038
-- ============================================================
-- A Project is a named group of decks inside a workspace — typically one
-- client proposal holding its decks. It is pure organization, NOT a
-- permission boundary: deck visibility / per-deck ACL (0015 / 0025) is
-- unchanged, and a private deck inside a project stays private.
--
--   1. public.canvas_project — workspace-scoped; name is unique per
--      workspace (case-insensitive) so MCP create_project can treat
--      "already exists" as "use that one" instead of minting duplicates.
--   2. canvas_deck.project_id — nullable FK, ON DELETE SET NULL: deleting
--      a project never deletes its decks, they just become ungrouped.
--   3. RLS: FULL members read/create (guests are deck-scoped outside
--      reviewers — they must not see the workspace's project taxonomy);
--      creator-or-admin update/delete, mirroring the canvas_deck shape.
--
-- Moving a deck between projects is an UPDATE on canvas_deck.project_id and
-- is governed by the existing "creators and admins update canvas decks"
-- policy — no new policy needed there.
-- ============================================================

create table public.canvas_project (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index canvas_project_workspace_idx
  on public.canvas_project(workspace_id);

-- Case-insensitive uniqueness inside a workspace: "Board Deck" and
-- "board deck" are the same project.
create unique index canvas_project_workspace_name_uq
  on public.canvas_project (workspace_id, lower(name));

create trigger set_updated_at_canvas_project
  before update on public.canvas_project
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- canvas_deck.project_id
-- ------------------------------------------------------------

alter table public.canvas_deck
  add column project_id uuid references public.canvas_project(id) on delete set null;

create index canvas_deck_project_idx
  on public.canvas_deck(project_id) where project_id is not null;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

alter table public.canvas_project enable row level security;

create policy "full members read projects"
  on public.canvas_project for select
  to authenticated
  using (public.is_workspace_member_full(workspace_id));

create policy "full members create projects"
  on public.canvas_project for insert
  to authenticated
  with check (
    public.is_workspace_member_full(workspace_id)
    and created_by = (select auth.uid())
  );

create policy "creators and admins update projects"
  on public.canvas_project for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member_full(workspace_id) and created_by = (select auth.uid()))
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member_full(workspace_id) and created_by = (select auth.uid()))
  );

create policy "creators and admins delete projects"
  on public.canvas_project for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member_full(workspace_id) and created_by = (select auth.uid()))
  );
