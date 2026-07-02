-- ============================================================
-- Deck activity log (slide deletions) — migration 0037
-- ============================================================
-- The history page now derives a per-deck activity feed ("Alice added
-- slide 5", "Bob rejected a proposal") at read time from the tables that
-- already record every action: canvas_deck_edit, canvas_slide_version,
-- canvas_deck_snapshot, canvas_comment. One action leaves NO trace today:
-- deleting a slide. The canvas_deck_slide FKs are ON DELETE CASCADE, so
-- approving a slide_delete erases the slide's versions, comments, pending
-- edits — and the slide_delete proposal row itself (its slide_id points at
-- the deleted slide; see the comment in 0024). "Who deleted slide 4?" was
-- unanswerable.
--
-- This adds a small append-only canvas_deck_activity table plus a BEFORE
-- DELETE trigger on canvas_deck_slide that records the deletion — actor,
-- proposer (when the delete came through the propose→approve loop, grabbed
-- before the cascade eats the proposal row), slide title and position.
--
-- Design notes:
--   * Soft references only (no FKs to deck/slide/users) — same pattern as
--     canvas_usage_event (0014). A deck-cascade delete fires this trigger
--     once per slide mid-cascade; FK'd rows pointing at the dying deck would
--     make the cascade fragile. Orphan rows are invisible (the feed queries
--     by an existing deck's id) and harmless.
--   * The table is generic (action + detail jsonb) so later actions can be
--     routed here if read-time derivation ever falls short, but today only
--     'slide_delete' is written.
--   * The logging function is SECURITY DEFINER (clients get no INSERT path;
--     RLS has no insert policy) and swallows its own errors — an audit-log
--     hiccup must never block the actual deletion.
-- ============================================================

create table public.canvas_deck_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,                  -- soft ref (no FK), see header
  deck_id uuid not null,                       -- soft ref
  slide_id uuid,                               -- soft ref; the slide is gone
  action text not null check (action in ('slide_delete')),
  actor_id uuid,                               -- who executed (auth.uid())
  actor_kind text not null default 'user' check (actor_kind in ('user', 'claude')),
  subject_user_id uuid,                        -- proposer, when distinct from actor
  detail jsonb not null default '{}',          -- slide_title, position, rationale, proposed_by_kind
  created_at timestamptz not null default now()
);

create index canvas_deck_activity_deck_idx
  on public.canvas_deck_activity(deck_id, created_at desc);

alter table public.canvas_deck_activity enable row level security;

-- Read: anyone who can read the deck (members + explicit deck guests, same
-- gate as the other deck surfaces since 0025). No INSERT/UPDATE/DELETE
-- policies — rows are written only by the SECURITY DEFINER trigger function.
create policy "deck readers read activity"
  on public.canvas_deck_activity
  for select
  using (public.canvas_can_read_deck(deck_id));

-- ------------------------------------------------------------
-- Trigger: log every slide deletion before the cascade erases context
-- ------------------------------------------------------------
create or replace function public.canvas_log_slide_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_edit public.canvas_deck_edit;
begin
  -- The pending slide_delete proposal targeting this slide, if the deletion
  -- came through the propose→approve loop. Still 'pending' here: in
  -- canvas_apply_edit the status update runs after the DELETE (and matches 0
  -- rows once the cascade removes the proposal). Read it now, before the
  -- cascade.
  select * into v_edit
    from public.canvas_deck_edit
   where slide_id = old.id
     and kind = 'slide_delete'
     and status = 'pending'
   order by created_at desc
   limit 1;

  insert into public.canvas_deck_activity (
    workspace_id, deck_id, slide_id, action,
    actor_id, actor_kind, subject_user_id, detail
  )
  values (
    old.workspace_id, old.deck_id, old.id, 'slide_delete',
    auth.uid(), 'user',
    case when v_edit.proposed_by is distinct from auth.uid() then v_edit.proposed_by end,
    jsonb_strip_nulls(jsonb_build_object(
      'slide_title', old.title,
      'position', old.position,
      'rationale', v_edit.rationale,
      'proposed_by_kind', v_edit.proposed_by_kind
    ))
  );
  return old;
exception when others then
  -- Audit failure must never block the deletion itself.
  raise warning 'canvas_log_slide_delete: % (slide %)', sqlerrm, old.id;
  return old;
end;
$$;

revoke execute on function public.canvas_log_slide_delete() from public, anon, authenticated;

create trigger canvas_deck_slide_log_delete
  before delete on public.canvas_deck_slide
  for each row execute function public.canvas_log_slide_delete();
