/**
 * Pure geometry for drag-to-reposition in the Adjust inspector (Model A: free
 * move, clamped to the slide). See ADR note in deck-workspace's inspect flow.
 *
 * Shipped as a STRING, not functions, on purpose. The drag handlers live inside
 * `CANVAS_EDITOR` (assemble.ts) — a sandboxed script island injected into the
 * preview iframe that cannot `import`. Interpolating this string into that
 * island keeps ONE source of truth that is also unit-tested here directly:
 * `new Function(DRAG_GEOMETRY_JS + "; return { ... }")()` (tests/drag-position.test.ts).
 *
 * Both functions are DOM-free and side-effect-free:
 *
 *   cvStageScale(secClientW, secOffsetW) -> number
 *     The kit scales a fixed authoring stage to the viewport (CSS `zoom` for the
 *     1920×1080 kit; 100vw for Canvas-native decks). A pointer delta is in
 *     on-screen px; an element's offset (left/top or a translate) is in
 *     authoring px. The slide section's on-screen width (getBoundingClientRect)
 *     over its layout width (offsetWidth) IS that scale — measured empirically so
 *     it holds for `zoom`, `transform: scale`, and vw alike. Falls back to 1 when
 *     unmeasurable (e.g. a non-visual context where rects read 0).
 *
 *   cvClampDelta(dx, dy, el, sec) -> { dx, dy }
 *     Clamp an on-screen pointer delta so the element box (el, captured at drag
 *     start) stays inside the slide box (sec). Both are {left,right,top,bottom}
 *     in on-screen px. When the slide has no measurable area it returns the delta
 *     unchanged — we don't restrict what we can't measure (and it keeps the math
 *     inert in jsdom, which does no layout).
 */
export const DRAG_GEOMETRY_JS = `
function cvStageScale(secClientW, secOffsetW) {
  if (!secClientW || !secOffsetW) return 1;
  var s = secClientW / secOffsetW;
  return (s > 0 && isFinite(s)) ? s : 1;
}
function cvClampDelta(dx, dy, el, sec) {
  if (!(sec.right > sec.left) || !(sec.bottom > sec.top)) return { dx: dx, dy: dy };
  var minDx = sec.left - el.left, maxDx = sec.right - el.right;
  var minDy = sec.top - el.top, maxDy = sec.bottom - el.bottom;
  return {
    dx: Math.max(minDx, Math.min(maxDx, dx)),
    dy: Math.max(minDy, Math.min(maxDy, dy))
  };
}
`.trim();
