/**
 * Pure geometry for drag-to-reposition and drag-to-resize in the Adjust
 * inspector (Model A: free move, clamped to the slide). See ADR note in
 * deck-workspace's inspect flow.
 *
 * Shipped as a STRING, not functions, on purpose. The drag handlers live inside
 * `CANVAS_EDITOR` (assemble.ts) — a sandboxed script island injected into the
 * preview iframe that cannot `import`. Interpolating this string into that
 * island keeps ONE source of truth that is also unit-tested here directly:
 * `new Function(DRAG_GEOMETRY_JS + "; return { ... }")()` (tests/drag-position.test.ts).
 *
 * All functions are DOM-free and side-effect-free:
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
 *
 *   cvResizeClamp(handle, dx, dy, el, sec, min, ratio) -> { dx, dy }
 *     Clamp a resize gesture. `handle` names the grabbed handle ('n','ne','e',
 *     'se','s','sw','w','nw'); dx/dy is the pointer's on-screen delta; el/sec
 *     are the boxes at gesture start. The returned deltas apply to the moving
 *     edges only (a pure-edge handle zeroes the cross axis). Three constraints:
 *       - min size: the box never shrinks below `min` px per axis — but a box
 *         ALREADY smaller than `min` is only prevented from shrinking further,
 *         never forced to grow.
 *       - slide bounds: the moving edge stays inside `sec` (skipped when the
 *         slide has no measurable area, same jsdom rationale as cvClampDelta).
 *       - ratio (corner handles, ratio > 0): the box scales uniformly, driven
 *         by whichever axis the pointer changed proportionally more; if a clamp
 *         then bites one axis, both are re-tightened to the more-restricted
 *         scale so the lock survives clamping.
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
function cvResizeClamp(handle, dx, dy, el, sec, min, ratio) {
  var hasE = handle.indexOf('e') !== -1, hasW = handle.indexOf('w') !== -1;
  var hasS = handle.indexOf('s') !== -1, hasN = handle.indexOf('n') !== -1;
  var w = el.right - el.left, h = el.bottom - el.top;
  if (!hasE && !hasW) dx = 0;
  if (!hasS && !hasN) dy = 0;
  var locked = ratio > 0 && (hasE || hasW) && (hasS || hasN) && w > 0 && h > 0;
  if (locked) {
    var sx = (w + (hasE ? dx : -dx)) / w;
    var sy = (h + (hasS ? dy : -dy)) / h;
    var s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    dx = (hasE ? 1 : -1) * (s - 1) * w;
    dy = (hasS ? 1 : -1) * (s - 1) * h;
  }
  var secOk = (sec.right > sec.left) && (sec.bottom > sec.top);
  var minW = Math.min(min, w), minH = Math.min(min, h);
  var cdx = dx, cdy = dy;
  if (hasE) cdx = Math.min(Math.max(cdx, minW - w), secOk ? sec.right - el.right : Infinity);
  if (hasW) cdx = Math.max(Math.min(cdx, w - minW), secOk ? sec.left - el.left : -Infinity);
  if (hasS) cdy = Math.min(Math.max(cdy, minH - h), secOk ? sec.bottom - el.bottom : Infinity);
  if (hasN) cdy = Math.max(Math.min(cdy, h - minH), secOk ? sec.top - el.top : -Infinity);
  if (locked && (cdx !== dx || cdy !== dy)) {
    var rsx = (w + (hasE ? cdx : -cdx)) / w;
    var rsy = (h + (hasS ? cdy : -cdy)) / h;
    var rs = Math.abs(rsx - 1) <= Math.abs(rsy - 1) ? rsx : rsy;
    cdx = (hasE ? 1 : -1) * (rs - 1) * w;
    cdy = (hasS ? 1 : -1) * (rs - 1) * h;
  }
  return { dx: cdx, dy: cdy };
}
`.trim();
