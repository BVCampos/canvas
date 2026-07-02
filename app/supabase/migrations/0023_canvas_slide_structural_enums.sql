-- ============================================================
-- Canvas structural slide ops — enum values (migration 0023)
-- ============================================================
-- Adds two proposal kinds that let Claude RESTRUCTURE a deck. Until now a deck
-- could only grow (slide_create) — there was no way to remove or move a slide.
--
--   slide_reorder — new_slide_payload = { "order": ["<slide_id>", ...] }
--                   (the deck's slides in their target order)
--   slide_delete  — slide_id identifies the slide to remove (no payload)
--
-- Like the slide_create (0009) and deck_title (0011) work, the ADD VALUEs live
-- in their OWN migration: Postgres cannot use a freshly-added enum value in the
-- same transaction that adds it, so the apply-path migration (0024) that
-- references these runs afterwards. `if not exists` keeps re-runs idempotent.
-- ============================================================

alter type public.canvas_edit_kind add value if not exists 'slide_reorder';
alter type public.canvas_edit_kind add value if not exists 'slide_delete';
