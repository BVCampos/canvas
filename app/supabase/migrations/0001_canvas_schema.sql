-- ============================================================
-- Canvas schema — v0
-- ============================================================
-- Sibling app to 21x-workforce-management; reuses the same Supabase project
-- (auth.users, public.workspaces, public.users, public.workspace_memberships,
-- public.is_workspace_member, public.is_workspace_admin_or_owner, public.set_updated_at).
--
-- Tables live in `public` with a `canvas_` prefix to avoid the extra
-- "exposed schemas" config step in Supabase Studio. Naming guarantees no
-- collision with workforce-management entities.
--
-- Tables:
--   canvas_deck                 — the HTML deck (workspace-scoped, optionally
--                                 linked to a Client and/or Proposal in workforce)
--   canvas_deck_slide           — ordered child of a deck
--   canvas_deck_slide_lock      — soft lock (15min), one per slide
--   canvas_deck_edit            — pending suggestion / applied edit (audit trail)
--   canvas_deck_asset           — image extracted from imported HTML, stored in Storage
--   canvas_deck_source          — pinned PDF / URL / file (context for Claude)
--   canvas_comment              — threaded comments on slide or deck, by user or Claude
--   canvas_mcp_token            — per-user secret for the personal MCP connector URL
--
-- RLS follows ADR-0004 pattern: open-read within Workspace, scoped-write.
-- ============================================================

-- ============================================================
-- Enums
-- ============================================================

create type public.canvas_deck_status as enum ('draft', 'in_review', 'final');
create type public.canvas_slide_status as enum ('draft', 'in_review', 'done');
create type public.canvas_edit_kind as enum ('slide_html', 'slide_styles', 'theme_css', 'nav_js');
create type public.canvas_edit_status as enum ('pending', 'applied', 'rejected', 'superseded');
create type public.canvas_source_kind as enum ('pdf', 'url', 'text', 'file');

-- ============================================================
-- canvas_deck
-- ============================================================

create table public.canvas_deck (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Plain UUIDs (no FK) — used to be `references public.clients(id)` and
  -- `references public.proposals(id)` when Canvas shared a Supabase project
  -- with workforce-management. After the standalone split (ADR-0004) those
  -- tables are gone; the columns survive so existing decks keep their soft
  -- link to the workforce CRM if someone reads them from the workforce app.
  client_id uuid,
  proposal_id uuid,
  title text not null,
  status public.canvas_deck_status not null default 'draft',
  theme_css text not null default '',
  nav_js text not null default '',
  meta jsonb not null default '{}',           -- title attr, lang, viewport, etc.
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index canvas_deck_workspace_idx on public.canvas_deck(workspace_id);
create index canvas_deck_workspace_status_idx on public.canvas_deck(workspace_id, status);
create index canvas_deck_client_idx on public.canvas_deck(client_id) where client_id is not null;
create index canvas_deck_proposal_idx on public.canvas_deck(proposal_id) where proposal_id is not null;

create trigger set_updated_at_canvas_deck
  before update on public.canvas_deck
  for each row execute function public.set_updated_at();

-- ============================================================
-- canvas_deck_slide
-- workspace_id denormalized for RLS fast-path (matches workforce-management pattern).
-- ============================================================

create table public.canvas_deck_slide (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deck_id uuid not null references public.canvas_deck(id) on delete cascade,
  position int not null,
  title text not null default '',
  html_body text not null default '',
  slide_styles text not null default '',       -- slide-scoped CSS that doesn't belong in the deck theme
  owner_id uuid references public.users(id) on delete set null,
  status public.canvas_slide_status not null default 'draft',
  source_prompt text,                          -- last prompt that produced this slide, if from Claude
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Position is unique within a deck. Deferrable so we can swap positions inside a transaction.
alter table public.canvas_deck_slide
  add constraint canvas_deck_slide_position_uq
  unique (deck_id, position) deferrable initially deferred;

create index canvas_deck_slide_deck_idx on public.canvas_deck_slide(deck_id, position);
create index canvas_deck_slide_workspace_idx on public.canvas_deck_slide(workspace_id);
create index canvas_deck_slide_owner_idx on public.canvas_deck_slide(owner_id) where owner_id is not null;

create trigger set_updated_at_canvas_deck_slide
  before update on public.canvas_deck_slide
  for each row execute function public.set_updated_at();

-- ============================================================
-- canvas_deck_slide_lock
-- One-row-per-slide soft lock. acquire = insert; release = delete; renew = update expires_at.
-- ============================================================

create table public.canvas_deck_slide_lock (
  slide_id uuid primary key references public.canvas_deck_slide(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  locked_by uuid not null references public.users(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);

create index canvas_deck_slide_lock_workspace_idx on public.canvas_deck_slide_lock(workspace_id);
create index canvas_deck_slide_lock_expires_idx on public.canvas_deck_slide_lock(expires_at);

-- ============================================================
-- canvas_deck_edit
-- Every proposed change to a slide / theme / nav. Applied edits become history.
-- ============================================================

create table public.canvas_deck_edit (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deck_id uuid not null references public.canvas_deck(id) on delete cascade,
  slide_id uuid references public.canvas_deck_slide(id) on delete cascade,   -- null when kind is 'theme_css' or 'nav_js'
  kind public.canvas_edit_kind not null,
  proposed_by uuid not null references public.users(id) on delete cascade,
  proposed_by_kind text not null default 'user' check (proposed_by_kind in ('user', 'claude')),
  new_content text not null,
  rationale text,
  status public.canvas_edit_status not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id) on delete set null
);

create index canvas_deck_edit_deck_idx on public.canvas_deck_edit(deck_id, status);
create index canvas_deck_edit_slide_idx on public.canvas_deck_edit(slide_id) where slide_id is not null;
create index canvas_deck_edit_workspace_status_idx on public.canvas_deck_edit(workspace_id, status);
create index canvas_deck_edit_proposer_idx on public.canvas_deck_edit(proposed_by);

-- ============================================================
-- canvas_deck_asset
-- Images / fonts / files extracted from imported HTML. Storage path lives in
-- the `decks` bucket (created in a later migration if not present).
-- ============================================================

create table public.canvas_deck_asset (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deck_id uuid not null references public.canvas_deck(id) on delete cascade,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint,
  original_src text,                           -- the data: URL or external URL it replaced (debugging)
  created_at timestamptz not null default now()
);

create index canvas_deck_asset_deck_idx on public.canvas_deck_asset(deck_id);
create index canvas_deck_asset_workspace_idx on public.canvas_deck_asset(workspace_id);

-- ============================================================
-- canvas_deck_source
-- Pinned context: PDFs, URLs, pasted text. Attached to deck (global context)
-- or slide (slide-specific context for Claude).
-- ============================================================

create table public.canvas_deck_source (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deck_id uuid not null references public.canvas_deck(id) on delete cascade,
  slide_id uuid references public.canvas_deck_slide(id) on delete cascade,
  kind public.canvas_source_kind not null,
  label text,
  url text,
  storage_path text,
  body text,                                   -- inline text sources
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index canvas_deck_source_deck_idx on public.canvas_deck_source(deck_id);
create index canvas_deck_source_slide_idx on public.canvas_deck_source(slide_id) where slide_id is not null;
create index canvas_deck_source_workspace_idx on public.canvas_deck_source(workspace_id);

-- ============================================================
-- canvas_comment
-- Threaded comments. Anchored to a slide (typical case) or to the deck.
-- author_kind = 'claude' means the comment was posted via MCP by an AI agent
-- on behalf of a user — author_id still references the human user whose token
-- was used (audit). element_selector reserved for v1.1 inline annotations.
-- ============================================================

create table public.canvas_comment (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deck_id uuid not null references public.canvas_deck(id) on delete cascade,
  slide_id uuid references public.canvas_deck_slide(id) on delete cascade,    -- null = deck-level
  parent_id uuid references public.canvas_comment(id) on delete cascade,      -- null = thread root
  author_kind text not null default 'user' check (author_kind in ('user', 'claude')),
  author_id uuid references public.users(id) on delete set null,
  body text not null,
  mentions jsonb not null default '[]'::jsonb, -- array of user_ids ["uuid", ...]
  element_selector text,                       -- v1.1: anchor to a DOM node within the slide
  resolved boolean not null default false,
  resolved_by uuid references public.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index canvas_comment_deck_idx on public.canvas_comment(deck_id);
create index canvas_comment_slide_idx on public.canvas_comment(slide_id) where slide_id is not null;
create index canvas_comment_parent_idx on public.canvas_comment(parent_id) where parent_id is not null;
create index canvas_comment_workspace_unresolved_idx on public.canvas_comment(workspace_id) where resolved = false;

create trigger set_updated_at_canvas_comment
  before update on public.canvas_comment
  for each row execute function public.set_updated_at();

-- ============================================================
-- canvas_mcp_token
-- Per-user secret carried in the MCP server URL. Identifies the user when
-- their Claude calls /api/mcp/{token}/... and scopes them to one workspace.
-- ============================================================

create table public.canvas_mcp_token (
  token text primary key,                       -- random URL-safe secret (32+ bytes)
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  label text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index canvas_mcp_token_user_idx on public.canvas_mcp_token(user_id) where revoked_at is null;
create index canvas_mcp_token_workspace_idx on public.canvas_mcp_token(workspace_id);

-- ============================================================
-- Enable RLS
-- ============================================================

alter table public.canvas_deck enable row level security;
alter table public.canvas_deck_slide enable row level security;
alter table public.canvas_deck_slide_lock enable row level security;
alter table public.canvas_deck_edit enable row level security;
alter table public.canvas_deck_asset enable row level security;
alter table public.canvas_deck_source enable row level security;
alter table public.canvas_comment enable row level security;
alter table public.canvas_mcp_token enable row level security;

-- ============================================================
-- Policies — canvas_deck
-- Open-read within workspace; creators and admins write.
-- ============================================================

create policy "members read canvas decks"
  on public.canvas_deck for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create canvas decks"
  on public.canvas_deck for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
  );

create policy "creators and admins update canvas decks"
  on public.canvas_deck for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and created_by = auth.uid())
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and created_by = auth.uid())
  );

create policy "creators and admins delete canvas decks"
  on public.canvas_deck for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and created_by = auth.uid())
  );

-- ============================================================
-- Policies — canvas_deck_slide
-- Members write to slides they own (or unowned); admins write anywhere.
-- ============================================================

create policy "members read slides"
  on public.canvas_deck_slide for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create slides"
  on public.canvas_deck_slide for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

create policy "slide owners and admins update slides"
  on public.canvas_deck_slide for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id)
        and (owner_id is null or owner_id = auth.uid() or created_by = auth.uid()))
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id)
        and (owner_id is null or owner_id = auth.uid() or created_by = auth.uid()))
  );

create policy "creators and admins delete slides"
  on public.canvas_deck_slide for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and created_by = auth.uid())
  );

-- ============================================================
-- Policies — canvas_deck_slide_lock
-- Anyone in the workspace can see locks (UI shows who has what); only the
-- lock holder can release/extend; admins can force-release.
-- ============================================================

create policy "members read locks"
  on public.canvas_deck_slide_lock for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members acquire own locks"
  on public.canvas_deck_slide_lock for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and locked_by = auth.uid()
  );

create policy "lock holder updates, admins force-update"
  on public.canvas_deck_slide_lock for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or locked_by = auth.uid()
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or locked_by = auth.uid()
  );

create policy "lock holder releases, admins force-release"
  on public.canvas_deck_slide_lock for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or locked_by = auth.uid()
  );

-- ============================================================
-- Policies — canvas_deck_edit
-- Audit-trail-like: members create proposals; status transitions are updates;
-- nothing is deleted (use status='superseded' instead).
-- ============================================================

create policy "members read edits"
  on public.canvas_deck_edit for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members propose edits"
  on public.canvas_deck_edit for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and proposed_by = auth.uid()
  );

create policy "members resolve edits"
  on public.canvas_deck_edit for update
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- No DELETE policy: edits are history.

-- ============================================================
-- Policies — canvas_deck_asset
-- ============================================================

create policy "members read assets"
  on public.canvas_deck_asset for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create assets"
  on public.canvas_deck_asset for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

create policy "admins delete assets"
  on public.canvas_deck_asset for delete
  to authenticated
  using (public.is_workspace_admin_or_owner(workspace_id));

-- ============================================================
-- Policies — canvas_deck_source
-- ============================================================

create policy "members read sources"
  on public.canvas_deck_source for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create sources"
  on public.canvas_deck_source for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

create policy "creators and admins delete sources"
  on public.canvas_deck_source for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and created_by = auth.uid())
  );

-- ============================================================
-- Policies — canvas_comment
-- ============================================================

create policy "members read comments"
  on public.canvas_comment for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create their own comments"
  on public.canvas_comment for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and author_id = auth.uid()
    and author_kind = 'user'
  );

create policy "authors and admins update comments"
  on public.canvas_comment for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and author_id = auth.uid())
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and author_id = auth.uid())
  );

create policy "authors and admins delete comments"
  on public.canvas_comment for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and author_id = auth.uid())
  );

-- ============================================================
-- Policies — canvas_mcp_token
-- Tokens are personal: only the owning user can see, create, update, or delete.
-- The MCP route itself resolves token → user via the service-role client
-- (bypasses RLS), so app code never needs to read these as the authenticated user.
-- ============================================================

create policy "users read own mcp tokens"
  on public.canvas_mcp_token for select
  to authenticated
  using (user_id = auth.uid());

create policy "users create own mcp tokens"
  on public.canvas_mcp_token for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

create policy "users update own mcp tokens"
  on public.canvas_mcp_token for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete own mcp tokens"
  on public.canvas_mcp_token for delete
  to authenticated
  using (user_id = auth.uid());
