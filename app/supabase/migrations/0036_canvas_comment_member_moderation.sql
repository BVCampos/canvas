-- 0036 — comment moderation for all workspace members
--
-- Before this, only the comment's author or a workspace admin/owner could
-- update (resolve) or delete a comment. In practice the whole team curates
-- decks together, and members hit a dead end trying to clean up Claude's or
-- teammates' comments. Relax UPDATE and DELETE on canvas_comment so ANY
-- workspace member can moderate any comment in their workspace.
--
-- Guests keep the old rule: they can only touch their own comments. Note
-- guests ARE workspace_memberships rows (role='guest', per 0025), so this
-- must use is_workspace_member_full — plain is_workspace_member would let
-- guests moderate too.
--
-- Follows the 0017 initplan convention: auth.uid() wrapped in a scalar
-- subquery so the planner evaluates it once.

drop policy if exists "authors and admins update comments" on public.canvas_comment;
create policy "members and authors update comments"
  on public.canvas_comment for update
  to authenticated
  using (
    public.is_workspace_member_full(workspace_id)
    or (public.canvas_can_read_deck(deck_id) and author_id = (select auth.uid()))
  )
  with check (
    public.is_workspace_member_full(workspace_id)
    or (public.canvas_can_read_deck(deck_id) and author_id = (select auth.uid()))
  );

drop policy if exists "authors and admins delete comments" on public.canvas_comment;
create policy "members and authors delete comments"
  on public.canvas_comment for delete
  to authenticated
  using (
    public.is_workspace_member_full(workspace_id)
    or (public.canvas_can_read_deck(deck_id) and author_id = (select auth.uid()))
  );
