-- ============================================================
-- Canvas comment anchor — migration 0004
-- ============================================================
-- Adds (anchor_x, anchor_y) to canvas_comment so a comment thread can be
-- pinned to a specific point on the slide canvas — PowerPoint-style.
--
-- Coordinates are normalised (0..1) against the slide's rendered rect, not
-- the iframe viewport. That way a pin stays glued to the same spot on the
-- slide regardless of how the deck is resized in the editor or on
-- different-sized screens during review. The host page receives the slide
-- rect from the iframe via the `canvas:slide-bounds` postMessage protocol
-- (see lib/canvas/assemble.ts) and converts pixels → fractions on insert.
--
-- Null anchors are legal: they represent slide-scoped comments that aren't
-- pinned to a position (e.g. comments posted by Claude via MCP that don't
-- care about coordinates, or v1.1 deck-level comments). UI treats null
-- anchors as floating thread bubbles in the right-rail comment list rather
-- than overlay pins.
-- ============================================================

alter table public.canvas_comment
  add column anchor_x numeric,
  add column anchor_y numeric;

alter table public.canvas_comment
  add constraint canvas_comment_anchor_paired_check
  check (
    (anchor_x is null and anchor_y is null)
    or (
      anchor_x is not null and anchor_y is not null
      and anchor_x >= 0 and anchor_x <= 1
      and anchor_y >= 0 and anchor_y <= 1
    )
  );

-- Partial index for the pinned-on-slide common-case query: "give me every
-- pin for slide X" runs every time a slide is shown in the editor.
create index canvas_comment_slide_pinned_idx
  on public.canvas_comment(slide_id)
  where slide_id is not null and anchor_x is not null;
