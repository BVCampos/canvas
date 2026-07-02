-- ============================================================
-- Canvas slide_title proposals — enum extension (migration 0028)
-- ============================================================
-- Adds the 'slide_title' value to public.canvas_edit_kind so a
-- canvas_deck_edit row can carry a slide-level title (label) change —
-- the name a slide shows in the editor's slide list. Until now
-- propose_slide_edit could only touch a slide's html_body or
-- slide_styles, so a slide that had been repurposed kept its old
-- sidebar label with no propose-path to fix it.
--
-- Sits in its own migration for the same reason as 0009 / 0011 / 0023:
-- Postgres forbids referencing a freshly-added enum value within the
-- same transaction that added it. The CHECK + canvas_apply_edit changes
-- that reference 'slide_title' ride in migration 0029. `if not exists`
-- keeps re-runs idempotent.
-- ============================================================

alter type public.canvas_edit_kind add value if not exists 'slide_title';
