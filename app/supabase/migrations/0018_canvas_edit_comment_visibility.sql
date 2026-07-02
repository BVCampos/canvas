-- ============================================================
-- Security: gate edit-comment access on deck visibility (migration 0018)
-- ============================================================
-- Migration 0015 moved every deck-child table's RLS to `canvas_can_read_deck`
-- so that a `private` deck's content is hidden from workspace members who were
-- not invited. `canvas_edit_comment` was missed (it's keyed by edit_id, not
-- deck_id) and still gated on bare `is_workspace_member(workspace_id)` — so a
-- non-invited member could read (and post into) the comment threads on a
-- private deck's proposals. This rewrites the four policies to resolve the
-- parent edit's deck and apply `canvas_can_read_deck`, consistent with the
-- rest of the schema. (Also wraps auth.uid() per the 0017 initplan pass.)
-- ============================================================

drop policy if exists "members read edit comments" on public.canvas_edit_comment;
create policy "users with deck access read edit comments" on public.canvas_edit_comment
  for select to authenticated
  using (exists (
    select 1 from public.canvas_deck_edit e
    where e.id = canvas_edit_comment.edit_id
      and public.canvas_can_read_deck(e.deck_id)
  ));

drop policy if exists "members create their own edit comments" on public.canvas_edit_comment;
create policy "deck members create edit comments" on public.canvas_edit_comment
  for insert to authenticated
  with check (
    (author_id = (select auth.uid()))
    and (author_kind = 'user'::text)
    and exists (
      select 1 from public.canvas_deck_edit e
      where e.id = canvas_edit_comment.edit_id
        and public.canvas_can_read_deck(e.deck_id)
    )
  );

drop policy if exists "authors and admins update edit comments" on public.canvas_edit_comment;
create policy "authors and admins update edit comments" on public.canvas_edit_comment
  for update to authenticated
  using (
    is_workspace_admin_or_owner(workspace_id)
    or ((author_id = (select auth.uid())) and exists (
      select 1 from public.canvas_deck_edit e
      where e.id = canvas_edit_comment.edit_id
        and public.canvas_can_read_deck(e.deck_id)
    ))
  )
  with check (
    is_workspace_admin_or_owner(workspace_id)
    or ((author_id = (select auth.uid())) and exists (
      select 1 from public.canvas_deck_edit e
      where e.id = canvas_edit_comment.edit_id
        and public.canvas_can_read_deck(e.deck_id)
    ))
  );

drop policy if exists "authors and admins delete edit comments" on public.canvas_edit_comment;
create policy "authors and admins delete edit comments" on public.canvas_edit_comment
  for delete to authenticated
  using (
    is_workspace_admin_or_owner(workspace_id)
    or ((author_id = (select auth.uid())) and exists (
      select 1 from public.canvas_deck_edit e
      where e.id = canvas_edit_comment.edit_id
        and public.canvas_can_read_deck(e.deck_id)
    ))
  );
