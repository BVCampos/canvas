-- ============================================================
-- Canvas slide_create proposals — enum extension (migration 0009)
-- ============================================================
-- Adds the 'slide_create' value to public.canvas_edit_kind so that
-- canvas_deck_edit rows can carry a "create a new slide" proposal
-- alongside the existing slide_html / slide_styles / theme_css / nav_js
-- kinds.
--
-- This sits in its own migration because Postgres forbids referencing
-- a freshly-added enum value within the same transaction that added it.
-- The structural changes that need to reference 'slide_create' in CHECK
-- constraints, trigger bodies, and the canvas_apply_edit RPC ride in
-- migration 0010.
-- ============================================================

alter type public.canvas_edit_kind add value if not exists 'slide_create';
