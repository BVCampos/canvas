-- ============================================================
-- Canvas realtime — migration 0006
-- ============================================================
-- Adds the three tables that drive the deck's multiplayer state to the
-- `supabase_realtime` publication so that Supabase Realtime broadcasts row
-- changes to clients listening via the websocket transport. The deck editor
-- subscribes per-deck and calls router.refresh() on any event.
--
-- Tables included:
--   canvas_comment           — pinned threads + replies (right rail, pins)
--   canvas_deck_slide_lock   — claim/release of slides (toolbar lock chip)
--   canvas_deck_slide        — covers lock state via current_version_id and
--                              re-publishes when slides change (apply edit,
--                              restore, reorder, etc.)
--
-- The publication is filter-less on the database side; per-deck filtering
-- happens on the client via the channel `filter` option. RLS still applies
-- to broadcast payloads (Realtime authorizes the subscriber against the
-- same policies as a SELECT), so non-members never receive cross-workspace
-- events.
-- ============================================================

alter publication supabase_realtime add table public.canvas_comment;
alter publication supabase_realtime add table public.canvas_deck_slide_lock;
alter publication supabase_realtime add table public.canvas_deck_slide;
