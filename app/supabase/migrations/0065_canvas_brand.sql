-- ============================================================
-- 0065 — brand kit (v0): one brand per workspace.
--
-- A canvas_brand row holds the workspace's design tokens (colors, font
-- stacks — flat JSON, no semantic layers in v0) and freeform voice rules.
-- Agents read it (read_brand MCP tool + auto-injection into the in-app
-- assistant's context) so generated slides are on-brand by construction
-- instead of re-explaining the palette every turn.
--
-- Deliberately NOT a proposal kind: brand is workspace configuration, so
-- edits are direct admin writes through RLS — the review rail and the
-- canvas_deck_edit taxonomy are untouched (that surface is the most
-- prod-bug-prone in the app; see the improvement map's kind-registry note).
--
-- Scope: one per workspace (unique). Per-project overrides are a later
-- extension, additive like project sharing (0046).
-- ============================================================

create table public.canvas_brand (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  -- Display label ("21x"), shown in settings; not a slug.
  name text,
  -- Flat token bag: { "colors": {"accent":"#2563eb", ...},
  --                   "fonts": {"sans":"Geist, Inter, sans-serif", ...} }.
  -- JSON (not CSS) because read_brand and a future lint need a queryable
  -- set; CSS is derived presentation.
  tokens jsonb not null default '{}'::jsonb,
  -- Freeform writing rules (markdown-ish). Injected, trimmed, into the
  -- assistant's context so copy matches the house voice.
  voice text,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at_canvas_brand
  before update on public.canvas_brand
  for each row execute function public.set_updated_at();

alter table public.canvas_brand enable row level security;

-- FULL members read (guests are deck-scoped outside reviewers — the
-- workspace's brand system is not theirs to enumerate); admins/owners write.
-- Matches how theme editing is gated in spirit: brand is a broader act.
create policy "full members read brand"
  on public.canvas_brand for select
  to authenticated
  using (public.is_workspace_member_full(workspace_id));

create policy "admins insert brand"
  on public.canvas_brand for insert
  to authenticated
  with check (public.is_workspace_admin_or_owner(workspace_id));

create policy "admins update brand"
  on public.canvas_brand for update
  to authenticated
  using (public.is_workspace_admin_or_owner(workspace_id))
  with check (public.is_workspace_admin_or_owner(workspace_id));

create policy "admins delete brand"
  on public.canvas_brand for delete
  to authenticated
  using (public.is_workspace_admin_or_owner(workspace_id));
