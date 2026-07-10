import { describe, expect, it } from "vitest";
import { DRAG_GEOMETRY_JS } from "@/lib/canvas/drag-position";

// Evaluate the same source that gets interpolated into the in-iframe
// CANVAS_EDITOR island, so this tests the shipped code, not a copy.
type Box = { left: number; right: number; top: number; bottom: number };
const geo = new Function(
  DRAG_GEOMETRY_JS + "; return { cvStageScale, cvClampDelta, cvResizeClamp };",
)() as {
  cvStageScale: (secClientW: number, secOffsetW: number) => number;
  cvClampDelta: (
    dx: number,
    dy: number,
    el: Box,
    sec: Box,
  ) => { dx: number; dy: number };
  cvResizeClamp: (
    handle: string,
    dx: number,
    dy: number,
    el: Box,
    sec: Box,
    min: number,
    ratio: number,
  ) => { dx: number; dy: number };
};

describe("cvStageScale", () => {
  it("is the on-screen/authoring width ratio", () => {
    expect(geo.cvStageScale(960, 1920)).toBe(0.5); // 1920 kit scaled to a 960px viewport
    expect(geo.cvStageScale(1920, 1920)).toBe(1); // native, unscaled
    expect(geo.cvStageScale(2400, 1920)).toBe(1.25); // scaled up
  });

  it("falls back to 1 when unmeasurable", () => {
    expect(geo.cvStageScale(0, 1920)).toBe(1); // jsdom / not yet laid out
    expect(geo.cvStageScale(1920, 0)).toBe(1);
    expect(geo.cvStageScale(-5, 10)).toBe(1);
  });
});

describe("cvClampDelta", () => {
  const sec: Box = { left: 0, top: 0, right: 1000, bottom: 800 };
  const el: Box = { left: 100, top: 100, right: 300, bottom: 250 };

  it("passes a delta that keeps the element inside the slide", () => {
    expect(geo.cvClampDelta(50, 40, el, sec)).toEqual({ dx: 50, dy: 40 });
  });

  it("clamps at the right/bottom edges", () => {
    // maxDx = 1000 - 300 = 700; maxDy = 800 - 250 = 550
    expect(geo.cvClampDelta(900, 900, el, sec)).toEqual({ dx: 700, dy: 550 });
  });

  it("clamps at the left/top edges", () => {
    // minDx = 0 - 100 = -100; minDy = 0 - 100 = -100
    expect(geo.cvClampDelta(-300, -300, el, sec)).toEqual({ dx: -100, dy: -100 });
  });

  it("does not restrict when the slide has no measurable area", () => {
    const zero: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(geo.cvClampDelta(37, -12, el, zero)).toEqual({ dx: 37, dy: -12 });
  });

  it("pins an oversized element to the slide's leading edge", () => {
    // Element wider/taller than the slide: min > max, so it snaps left/top edge.
    const big: Box = { left: -20, top: -20, right: 1010, bottom: 820 };
    expect(geo.cvClampDelta(0, 0, big, sec)).toEqual({ dx: 20, dy: 20 });
  });
});

describe("cvResizeClamp", () => {
  const sec: Box = { left: 0, top: 0, right: 1000, bottom: 800 };
  // 200×150 box, 100px from each slide edge it can grow toward.
  const el: Box = { left: 100, top: 100, right: 300, bottom: 250 };
  const MIN = 8;

  it("passes an in-bounds grow through unchanged (se)", () => {
    expect(geo.cvResizeClamp("se", 40, 30, el, sec, MIN, 0)).toEqual({
      dx: 40,
      dy: 30,
    });
  });

  it("zeroes the cross axis on pure-edge handles", () => {
    expect(geo.cvResizeClamp("e", 40, 30, el, sec, MIN, 0)).toEqual({
      dx: 40,
      dy: 0,
    });
    expect(geo.cvResizeClamp("s", 40, 30, el, sec, MIN, 0)).toEqual({
      dx: 0,
      dy: 30,
    });
  });

  it("stops the moving edge at the slide bounds", () => {
    // maxDx = 1000 - 300 = 700; maxDy = 800 - 250 = 550
    expect(geo.cvResizeClamp("se", 900, 900, el, sec, MIN, 0)).toEqual({
      dx: 700,
      dy: 550,
    });
    // nw: minDx = 0 - 100 = -100; minDy = 0 - 100 = -100
    expect(geo.cvResizeClamp("nw", -300, -300, el, sec, MIN, 0)).toEqual({
      dx: -100,
      dy: -100,
    });
  });

  it("never shrinks below the minimum size", () => {
    // e: w = 200, so dx >= 8 - 200 = -192
    expect(geo.cvResizeClamp("e", -500, 0, el, sec, MIN, 0)).toEqual({
      dx: -192,
      dy: 0,
    });
    // w shrinks by moving right: dx <= 200 - 8 = 192
    expect(geo.cvResizeClamp("w", 500, 0, el, sec, MIN, 0)).toEqual({
      dx: 192,
      dy: 0,
    });
    // n shrinks by moving down: dy <= 150 - 8 = 142
    expect(geo.cvResizeClamp("n", 0, 500, el, sec, MIN, 0)).toEqual({
      dx: 0,
      dy: 142,
    });
  });

  it("does not force a sub-minimum box to grow", () => {
    const tiny: Box = { left: 100, top: 100, right: 104, bottom: 103 };
    // Already 4×3 < min 8: shrinking clamps to 0, growing still works.
    expect(geo.cvResizeClamp("se", -50, -50, tiny, sec, MIN, 0)).toEqual({
      dx: 0,
      dy: 0,
    });
    expect(geo.cvResizeClamp("se", 20, 10, tiny, sec, MIN, 0)).toEqual({
      dx: 20,
      dy: 10,
    });
  });

  it("skips the slide-bounds clamp when the slide is unmeasurable", () => {
    const zero: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(geo.cvResizeClamp("se", 900, 900, el, zero, MIN, 0)).toEqual({
      dx: 900,
      dy: 900,
    });
    // min-size still applies without a measurable slide
    expect(geo.cvResizeClamp("e", -500, 0, el, zero, MIN, 0)).toEqual({
      dx: -192,
      dy: 0,
    });
  });

  it("ratio-locks a corner to the dominant axis", () => {
    // 200×150 box, ratio 4:3. dx=+50 is sx=1.25; dy=+15 is sy=1.1 → x wins.
    const r = geo.cvResizeClamp("se", 50, 15, el, sec, MIN, 200 / 150);
    expect(r.dx).toBeCloseTo(50);
    expect(r.dy).toBeCloseTo(37.5); // 150 * 0.25
  });

  it("ratio-locks against the pull direction on nw (negative = grow)", () => {
    const r = geo.cvResizeClamp("nw", -50, 0, el, sec, MIN, 200 / 150);
    expect(r.dx).toBeCloseTo(-50); // left edge out 50 → sx = 1.25
    expect(r.dy).toBeCloseTo(-37.5); // top edge out 37.5 keeps 4:3
  });

  it("re-tightens both axes when a clamp bites a ratio-locked resize", () => {
    // dx=+800 wants sx=5, dy scales to 4*150=600 — but maxDy is 550 (sy≈4.67)
    // and maxDx is 700 (sx=4.5). The tighter scale (4.5) wins on both axes.
    const r = geo.cvResizeClamp("se", 800, 0, el, sec, MIN, 200 / 150);
    expect(r.dx).toBeCloseTo(700); // 3.5 * 200
    expect(r.dy).toBeCloseTo(525); // 3.5 * 150
  });

  it("ignores ratio on pure-edge handles", () => {
    expect(geo.cvResizeClamp("e", 50, 0, el, sec, MIN, 200 / 150)).toEqual({
      dx: 50,
      dy: 0,
    });
  });
});
