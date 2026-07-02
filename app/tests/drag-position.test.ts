import { describe, expect, it } from "vitest";
import { DRAG_GEOMETRY_JS } from "@/lib/canvas/drag-position";

// Evaluate the same source that gets interpolated into the in-iframe
// CANVAS_EDITOR island, so this tests the shipped code, not a copy.
type Box = { left: number; right: number; top: number; bottom: number };
const geo = new Function(
  DRAG_GEOMETRY_JS + "; return { cvStageScale, cvClampDelta };",
)() as {
  cvStageScale: (secClientW: number, secOffsetW: number) => number;
  cvClampDelta: (
    dx: number,
    dy: number,
    el: Box,
    sec: Box,
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
