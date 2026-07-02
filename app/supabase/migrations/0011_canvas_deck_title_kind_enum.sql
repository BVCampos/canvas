-- ============================================================
-- Canvas deck_title proposals — enum extension (migration 0011)
-- ============================================================
-- Adds the 'deck_title' value to public.canvas_edit_kind so that
-- canvas_deck_edit rows can carry a deck-level title-change proposal
-- alongside the existing slide_html / slide_styles / slide_create /
-- theme_css / nav_js kinds.
--
-- Sits in its own migration for the same reason as 0009: Postgres
-- forbids referencing a freshly-added enum value within the same
-- transaction that added it. The structural changes that need to
-- reference 'deck_title' in CHECK constraints, the immutability
-- trigger, and the canvas_apply_edit RPC ride in migration 0012.
-- ============================================================

alter type public.canvas_edit_kind add value if not exists 'deck_title';
