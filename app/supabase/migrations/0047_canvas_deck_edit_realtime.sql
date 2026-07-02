-- ============================================================
-- Canvas realtime — migration 0047
-- ============================================================
-- Adds public.canvas_deck_edit (the proposal table) to the `supabase_realtime`
-- publication so row changes broadcast over the websocket transport.
--
-- WHY: two clients already subscribe to postgres_changes on canvas_deck_edit —
--   • app/src/app/canvases/[id]/use-deck-realtime.ts (re-hydrates the deck on
--     proposal insert/approve/reject/withdraw from another surface)
--   • app/src/app/canvases/[id]/assistant-panel.tsx (inline proposal cards
--     re-hydrate when a proposal's status flips elsewhere)
-- …but the table was NEVER in any publication (0006 published only
-- canvas_comment / canvas_deck_slide_lock / canvas_deck_slide). So a pure
-- status flip (reject, withdraw) produced no live event — inline proposal
-- cards only updated as a side-effect when a slide row happened to change.
-- This one line lights up the already-written subscriptions with no code change.
--
-- RLS still authorizes every broadcast: Realtime checks the subscriber against
-- the same SELECT policies as a query, so non-members never receive an edit row
-- for a deck they can't read. Per-deck filtering happens client-side via the
-- channel `filter` option.
--
-- Idempotent: guarded so re-applying (or a fresh DB that already has it) is a
-- no-op rather than erroring with "table is already in publication".
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'canvas_deck_edit'
  ) then
    alter publication supabase_realtime add table public.canvas_deck_edit;
  end if;
end
$$;
