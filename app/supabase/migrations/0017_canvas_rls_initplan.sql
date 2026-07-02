-- ============================================================
-- Performance: RLS initplan + permissive-policy consolidation (migration 0017)
-- ============================================================
-- The performance advisor flags policies that call `auth.uid()` directly: the
-- planner re-evaluates it per row. Wrapping it as `(select auth.uid())` makes
-- Postgres evaluate it once (an InitPlan) and reuse the scalar. This is a
-- well-known, SEMANTICS-PRESERVING transform — the only change is when the
-- function is evaluated, not what it returns. Expressions below are copied
-- verbatim from the live policies with `auth.uid()` → `(select auth.uid())`.
--
-- Also consolidates the two permissive SELECT policies on `public.users` into
-- one (the advisor's multiple_permissive_policies warning) — multiple
-- permissive policies for the same role+action are OR'd but each is evaluated,
-- so a single OR'd policy is cheaper and clearer.
-- ============================================================

-- canvas_comment -------------------------------------------------------------
alter policy "authors and admins delete comments" on public.canvas_comment
  using (is_workspace_admin_or_owner(workspace_id) or (canvas_can_read_deck(deck_id) and (author_id = (select auth.uid()))));
alter policy "deck members comment" on public.canvas_comment
  with check (canvas_can_read_deck(deck_id) and (author_id = (select auth.uid())) and (author_kind = 'user'::text));
alter policy "authors and admins update comments" on public.canvas_comment
  using (is_workspace_admin_or_owner(workspace_id) or (canvas_can_read_deck(deck_id) and (author_id = (select auth.uid()))))
  with check (is_workspace_admin_or_owner(workspace_id) or (canvas_can_read_deck(deck_id) and (author_id = (select auth.uid()))));

-- canvas_deck ----------------------------------------------------------------
alter policy "creators and admins delete canvas decks" on public.canvas_deck
  using (is_workspace_admin_or_owner(workspace_id) or (is_workspace_member(workspace_id) and (created_by = (select auth.uid()))));
alter policy "members create canvas decks" on public.canvas_deck
  with check (is_workspace_member(workspace_id) and (created_by = (select auth.uid())));
alter policy "editors and admins update decks" on public.canvas_deck
  using (is_workspace_admin_or_owner(workspace_id) or (created_by = (select auth.uid())) or (exists ( select 1
     from canvas_deck_member m
    where ((m.deck_id = canvas_deck.id) and (m.user_id = (select auth.uid())) and (m.role = 'editor'::canvas_deck_member_role)))))
  with check (is_workspace_admin_or_owner(workspace_id) or (created_by = (select auth.uid())) or (exists ( select 1
     from canvas_deck_member m
    where ((m.deck_id = canvas_deck.id) and (m.user_id = (select auth.uid())) and (m.role = 'editor'::canvas_deck_member_role)))));

-- canvas_deck_edit -----------------------------------------------------------
alter policy "editors propose edits" on public.canvas_deck_edit
  with check (canvas_can_edit_deck(deck_id) and (proposed_by = (select auth.uid())));

-- canvas_deck_member ---------------------------------------------------------
alter policy "editors admins or self remove deck members" on public.canvas_deck_member
  using ((user_id = (select auth.uid())) or is_workspace_admin_or_owner(workspace_id) or canvas_can_edit_deck(deck_id));
alter policy "users read own deck memberships and editors read all" on public.canvas_deck_member
  using ((user_id = (select auth.uid())) or is_workspace_admin_or_owner(workspace_id) or canvas_can_edit_deck(deck_id));

-- canvas_deck_slide ----------------------------------------------------------
alter policy "creators and admins delete slides" on public.canvas_deck_slide
  using (is_workspace_admin_or_owner(workspace_id) or (canvas_can_edit_deck(deck_id) and (created_by = (select auth.uid()))));
alter policy "slide owners and editors update slides" on public.canvas_deck_slide
  using (is_workspace_admin_or_owner(workspace_id) or (canvas_can_edit_deck(deck_id) and ((owner_id is null) or (owner_id = (select auth.uid())) or (created_by = (select auth.uid())))))
  with check (is_workspace_admin_or_owner(workspace_id) or (canvas_can_edit_deck(deck_id) and ((owner_id is null) or (owner_id = (select auth.uid())) or (created_by = (select auth.uid())))));

-- canvas_deck_slide_lock -----------------------------------------------------
alter policy "lock holder releases, admins force-release" on public.canvas_deck_slide_lock
  using (is_workspace_admin_or_owner(workspace_id) or (locked_by = (select auth.uid())));
alter policy "editors acquire own locks" on public.canvas_deck_slide_lock
  with check ((locked_by = (select auth.uid())) and (exists ( select 1
     from canvas_deck_slide s
    where ((s.id = canvas_deck_slide_lock.slide_id) and canvas_can_edit_deck(s.deck_id)))));
alter policy "lock holder updates, admins force-update" on public.canvas_deck_slide_lock
  using (is_workspace_admin_or_owner(workspace_id) or (locked_by = (select auth.uid())))
  with check (is_workspace_admin_or_owner(workspace_id) or (locked_by = (select auth.uid())));

-- canvas_deck_source ---------------------------------------------------------
alter policy "creators and admins delete sources" on public.canvas_deck_source
  using (is_workspace_admin_or_owner(workspace_id) or (canvas_can_edit_deck(deck_id) and (created_by = (select auth.uid()))));

-- canvas_mcp_token -----------------------------------------------------------
alter policy "users delete own mcp tokens" on public.canvas_mcp_token
  using (user_id = (select auth.uid()));
alter policy "users create own mcp tokens" on public.canvas_mcp_token
  with check ((user_id = (select auth.uid())) and is_workspace_member(workspace_id));
alter policy "users read own mcp tokens" on public.canvas_mcp_token
  using (user_id = (select auth.uid()));
alter policy "users update own mcp tokens" on public.canvas_mcp_token
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- users ----------------------------------------------------------------------
-- Consolidate the two permissive SELECT policies into one OR'd policy, and
-- wrap auth.uid(). Preserves identical access: own profile OR a co-member's.
drop policy if exists "users read co-members profiles" on public.users;
drop policy if exists "users read own profile" on public.users;
create policy "users read own and co-member profiles" on public.users
  for select to authenticated
  using ((id = (select auth.uid())) or is_co_member(id));

alter policy "users update own profile" on public.users
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
