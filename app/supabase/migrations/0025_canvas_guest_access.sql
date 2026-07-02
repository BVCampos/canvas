-- ============================================================
-- Scoped guest access: invite outside reviewers to a single deck (migration 0025)
-- ============================================================
-- Lets an editor/admin invite someone WITHOUT a workspace account (e.g. no
-- example.com email) to view + comment on ONE deck, without granting them
-- any other workspace deck.
--
-- The `guest` role already exists in the workspace_role enum but was dormant
-- and — critically — treated identically to a full member by every RLS gate
-- (they all call is_workspace_member, which returns true for ANY membership
-- row regardless of role). This migration makes `guest` mean what it says:
--
--   guest  = a workspace membership that grants NO blanket access. A guest can
--            reach a deck ONLY via an explicit canvas_deck_member row.
--
-- We do this surgically rather than redefining is_workspace_member globally:
--   1. New helper is_workspace_member_full() = role in (owner|admin|member).
--   2. Deck-access functions check the explicit canvas_deck_member grant
--      independently, and gate the visibility='workspace' shortcut on
--      is_workspace_member_full. For non-guests this is IDENTICAL to today.
--   3. A handful of capability policies (create deck, mint MCP token, read the
--      member roster) move from is_workspace_member -> is_workspace_member_full
--      so a guest can't do them.
--   4. workspaces SELECT and users/is_co_member are LEFT on is_workspace_member
--      (any role) so a guest can still resolve their workspace (else they'd be
--      bounced to /no-workspace) and see co-members' display names.
-- ============================================================

-- 1. Helper: a "full" member (excludes guests) -------------------------------
create or replace function public.is_workspace_member_full(_workspace_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = _workspace_id
      and user_id = auth.uid()
      and role in ('owner', 'admin', 'member')
  );
$function$;

-- 2. Deck-access functions ---------------------------------------------------
-- Read: admin/owner, OR an explicit deck-member row (any role — this is the
-- guest path), OR a full member when the deck is workspace-visible. The only
-- behavioural change vs. the old definition is that the visibility='workspace'
-- shortcut now requires is_workspace_member_full instead of is_workspace_member,
-- so guests are excluded from it. Members/admins are unaffected.
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
      )
  );
$function$;

-- Edit: same shape, but the explicit grant must be an editor row.
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
      )
  );
$function$;

-- 3. Capability policies: exclude guests -------------------------------------
-- A guest must not create decks, delete decks, or mint MCP tokens.
alter policy "members create canvas decks" on public.canvas_deck
  with check (is_workspace_member_full(workspace_id) and (created_by = (select auth.uid())));

alter policy "creators and admins delete canvas decks" on public.canvas_deck
  using (is_workspace_admin_or_owner(workspace_id) or (is_workspace_member_full(workspace_id) and (created_by = (select auth.uid()))));

alter policy "users create own mcp tokens" on public.canvas_mcp_token
  with check ((user_id = (select auth.uid())) and is_workspace_member_full(workspace_id));

-- A guest may read only their OWN membership row (so getActiveWorkspace can
-- resolve the workspace); full members keep reading the whole roster.
alter policy "members read memberships in their workspaces" on public.workspace_memberships
  using ((user_id = (select auth.uid())) or is_workspace_member_full(workspace_id));

-- 4. workspace_invites: optional per-deck scope ------------------------------
-- When deck_id/deck_role are set, accepting the invite also grants a
-- canvas_deck_member row on that deck. A guest invite MUST be deck-scoped
-- (otherwise the guest would have no access to anything).
alter table public.workspace_invites
  add column deck_id uuid references public.canvas_deck(id) on delete cascade,
  add column deck_role public.canvas_deck_member_role;

alter table public.workspace_invites
  add constraint workspace_invites_deck_scope_chk
    check (
      (deck_id is null and deck_role is null)
      or (deck_id is not null and deck_role is not null)
    );

alter table public.workspace_invites
  add constraint workspace_invites_guest_requires_deck_chk
    check (role <> 'guest'::public.workspace_role or deck_id is not null);

create index workspace_invites_deck_idx on public.workspace_invites(deck_id)
  where deck_id is not null;
