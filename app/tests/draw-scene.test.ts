// Unit tests for the pure drawing-scene model (src/lib/canvas/draw/scene.ts):
// SVG serialization, the lossless scene <-> slide-HTML round trip (the
// re-editable payload), hit-testing, bounds, and translate.

import { describe, it, expect } from "vitest";
import {
  emptyScene,
  sceneToSvg,
  sceneToSlideHtml,
  parseSceneFromHtml,
  isDrawnSlideHtml,
  encodeScene,
  decodeScene,
  freehandPathD,
  hitTest,
  elementBounds,
  translateElement,
  normalizeBox,
  sceneToOverlaySvg,
  injectDrawOverlay,
  stripDrawOverlay,
  hasDrawOverlayHtml,
  DRAW_W,
  DRAW_H,
  DRAW_SLIDE_CLASS,
  DRAW_OVERLAY_CLASS,
  type DrawScene,
  type DrawElement,
} from "@/lib/canvas/draw/scene";

const rect = (over: Partial<DrawElement> = {}): DrawElement => ({
  id: "r1",
  type: "rect",
  x: 100,
  y: 100,
  w: 200,
  h: 120,
  stroke: "#1e1e1e",
  strokeWidth: 4,
  fill: "none",
  ...(over as object),
}) as DrawElement;

const sceneWith = (...elements: DrawElement[]): DrawScene => ({
  ...emptyScene("#ffffff"),
  elements,
});

describe("emptyScene", () => {
  it("is a 1280x720 v1 scene with no elements", () => {
    const s = emptyScene();
    expect(s).toEqual({
      version: 1,
      width: DRAW_W,
      height: DRAW_H,
      background: "#ffffff",
      elements: [],
    });
  });
});

describe("sceneToSvg", () => {
  it("emits a viewBox-sized svg with a background rect and a node per element", () => {
    const svg = sceneToSvg(sceneWith(rect(), { id: "t", type: "text", x: 10, y: 20, text: "hi", fontSize: 32, color: "#000" } as DrawElement));
    expect(svg).toContain(`viewBox="0 0 ${DRAW_W} ${DRAW_H}"`);
    expect(svg).toContain('width="1280" height="720" fill="#ffffff"'); // bg rect
    expect(svg).toContain("<rect ");
    expect(svg).toContain("<text ");
    expect(svg).toMatch(/^<svg/);
    expect(svg).toMatch(/<\/svg>$/);
  });

  it("omits the background rect when transparent", () => {
    const s = { ...emptyScene("transparent"), elements: [rect()] };
    const svg = sceneToSvg(s);
    // Only the rect element fill, no full-bleed background rect.
    expect(svg).not.toContain('x="0" y="0" width="1280" height="720"');
  });

  it("escapes XML in text content and colours", () => {
    const svg = sceneToSvg(
      sceneWith({
        id: "t",
        type: "text",
        x: 0,
        y: 0,
        text: 'a < b & "c"',
        fontSize: 24,
        color: "#111",
      } as DrawElement),
    );
    expect(svg).toContain("a &lt; b &amp; ");
    expect(svg).not.toContain("a < b & ");
  });

  it("renders a single-point freehand as a dot (circle)", () => {
    const svg = sceneToSvg(
      sceneWith({
        id: "f",
        type: "freehand",
        points: [50, 60],
        stroke: "#000",
        strokeWidth: 6,
      } as DrawElement),
    );
    expect(svg).toContain('<circle cx="50" cy="60"');
  });

  it("emits an arrow as a line plus a head path", () => {
    const svg = sceneToSvg(
      sceneWith({
        id: "a",
        type: "arrow",
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        stroke: "#000",
        strokeWidth: 4,
      } as DrawElement),
    );
    expect(svg).toContain("<line ");
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
  });
});

describe("freehandPathD", () => {
  it("returns a move for one point, a line for two, and quadratics for more", () => {
    expect(freehandPathD([10, 10])).toBe("M 10 10");
    expect(freehandPathD([0, 0, 10, 10])).toBe("M 0 0 L 10 10");
    const d = freehandPathD([0, 0, 10, 0, 20, 10]);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d).toContain("Q ");
  });
});

describe("scene <-> slide HTML round trip", () => {
  it("sceneToSlideHtml produces a re-editable drawn slide section", () => {
    const s = sceneWith(rect());
    const html = sceneToSlideHtml(s);
    expect(html).toContain(`class="slide ${DRAW_SLIDE_CLASS}"`);
    expect(html).toContain("data-canvas-scene=");
    expect(html).toContain("<svg");
    expect(isDrawnSlideHtml(html)).toBe(true);
  });

  it("parseSceneFromHtml recovers the exact scene (lossless)", () => {
    const s = sceneWith(
      rect(),
      {
        id: "t",
        type: "text",
        x: 5,
        y: 6,
        text: 'tricky < & " text',
        fontSize: 28,
        color: "#abc123",
      } as DrawElement,
      {
        id: "f",
        type: "freehand",
        points: [1, 2, 3, 4, 5.5, 6.5],
        stroke: "#ff0000",
        strokeWidth: 3,
      } as DrawElement,
    );
    const back = parseSceneFromHtml(sceneToSlideHtml(s));
    expect(back).toEqual(s);
  });

  it("encode/decode is a faithful round trip", () => {
    const s = sceneWith(rect());
    expect(decodeScene(encodeScene(s))).toEqual(s);
  });

  it("decodeScene rejects malformed / non-scene payloads", () => {
    expect(decodeScene("not%20json")).toBeNull();
    expect(decodeScene(encodeURIComponent(JSON.stringify({ version: 2 })))).toBeNull();
  });

  it("isDrawnSlideHtml / parseSceneFromHtml are false/null for a normal slide", () => {
    const html = '<section class="slide"><h1>Normal</h1></section>';
    expect(isDrawnSlideHtml(html)).toBe(false);
    expect(parseSceneFromHtml(html)).toBeNull();
    expect(parseSceneFromHtml(null)).toBeNull();
  });
});

describe("hitTest", () => {
  it("hits a filled rect's interior and misses outside", () => {
    const s = sceneWith(rect({ fill: "#eee" }));
    expect(hitTest(s, 150, 150)).toBe("r1");
    expect(hitTest(s, 5, 5)).toBeNull();
  });

  it("an unfilled rect is hit on its border, not its hollow interior", () => {
    const s = sceneWith(rect({ fill: "none" }));
    expect(hitTest(s, 100, 150, 6)).toBe("r1"); // on the left edge
    expect(hitTest(s, 200, 160, 6)).toBeNull(); // dead centre, hollow
  });

  it("returns the topmost (last-drawn) element under the point", () => {
    const s = sceneWith(
      rect({ id: "under", fill: "#eee" }),
      rect({ id: "over", fill: "#ccc" }),
    );
    expect(hitTest(s, 150, 150)).toBe("over");
  });

  it("hits a thin line within tolerance of the segment", () => {
    const s = sceneWith({
      id: "l",
      type: "line",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      stroke: "#000",
      strokeWidth: 2,
    } as DrawElement);
    expect(hitTest(s, 50, 3, 8)).toBe("l");
    expect(hitTest(s, 50, 40, 8)).toBeNull();
  });
});

describe("elementBounds + translateElement + normalizeBox", () => {
  it("normalizeBox flips negative sizes", () => {
    expect(normalizeBox(100, 100, -40, -20)).toEqual({ x: 60, y: 80, w: 40, h: 20 });
  });

  it("bounds a freehand by its extreme points", () => {
    const b = elementBounds({
      id: "f",
      type: "freehand",
      points: [10, 20, 50, 5, 30, 60],
      stroke: "#000",
      strokeWidth: 2,
    } as DrawElement);
    expect(b).toEqual({ x: 10, y: 5, w: 40, h: 55 });
  });

  it("translate moves every coordinate", () => {
    const moved = translateElement(rect(), 10, -5);
    expect(moved).toMatchObject({ x: 110, y: 95, w: 200, h: 120 });
    const line = translateElement(
      { id: "l", type: "line", x1: 0, y1: 0, x2: 10, y2: 10, stroke: "#000", strokeWidth: 2 } as DrawElement,
      5,
      5,
    );
    expect(line).toMatchObject({ x1: 5, y1: 5, x2: 15, y2: 15 });
    const fh = translateElement(
      { id: "f", type: "freehand", points: [0, 0, 10, 10], stroke: "#000", strokeWidth: 2 } as DrawElement,
      2,
      3,
    );
    expect((fh as { points: number[] }).points).toEqual([2, 3, 12, 13]);
  });
});

describe("sceneToSvg — attribute injection safety", () => {
  it("escapes a double-quote in attribute values (stroke/fill/color); no breakout", () => {
    const svg = sceneToSvg(
      sceneWith(
        rect({ stroke: '#000" onload="alert(1)', fill: '#fff" x="0' }),
        {
          id: "t",
          type: "text",
          x: 0,
          y: 0,
          text: "ok",
          fontSize: 20,
          color: '#111" onclick="x',
        } as DrawElement,
      ),
    );
    // The `"`-bearing values must not close their attribute and inject handlers.
    expect(svg).not.toContain('onload="alert');
    expect(svg).not.toContain('onclick="x');
    expect(svg).toContain("&quot;");
  });
});

describe("ellipse element", () => {
  const ell = (over: Partial<DrawElement> = {}): DrawElement =>
    ({
      id: "e1",
      type: "ellipse",
      x: 100,
      y: 100,
      w: 200,
      h: 100,
      stroke: "#1971c2",
      strokeWidth: 4,
      fill: "none",
      ...(over as object),
    }) as DrawElement;

  it("serializes to an <ellipse> with the right center + radii", () => {
    expect(sceneToSvg(sceneWith(ell()))).toContain(
      '<ellipse cx="200" cy="150" rx="100" ry="50"',
    );
  });

  it("filled ellipse hits its interior, misses outside", () => {
    const s = sceneWith(ell({ fill: "#eee" }));
    expect(hitTest(s, 200, 150)).toBe("e1"); // center
    expect(hitTest(s, 5, 5)).toBeNull();
  });

  it("hollow ellipse hits the rim, not the empty center", () => {
    const s = sceneWith(ell({ fill: "none" }));
    expect(hitTest(s, 300, 150, 6)).toBe("e1"); // right rim (x = cx + rx)
    expect(hitTest(s, 200, 150, 6)).toBeNull(); // dead center, hollow
  });

  it("bounds a normalized ellipse box", () => {
    expect(elementBounds(ell())).toEqual({ x: 100, y: 100, w: 200, h: 100 });
  });
});

describe("multi-line text", () => {
  const txt = (text: string): DrawElement =>
    ({ id: "t", type: "text", x: 10, y: 20, text, fontSize: 40, color: "#000" }) as DrawElement;

  it("emits one <tspan> per line, keeping a blank middle line", () => {
    const svg = sceneToSvg(sceneWith(txt("line one\n\nline three")));
    expect((svg.match(/<tspan /g) ?? []).length).toBe(3);
  });

  it("bounds height grows with the line count", () => {
    expect(elementBounds(txt("a\nb\nc")).h).toBeCloseTo(elementBounds(txt("a")).h * 3);
  });

  it("round-trips a newline through slide HTML losslessly", () => {
    const s = sceneWith(txt("first\nsecond"));
    expect(parseSceneFromHtml(sceneToSlideHtml(s))).toEqual(s);
  });
});

describe("decodeScene — element validation (hardened boundary)", () => {
  const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
  const base = { version: 1, width: 1280, height: 720, background: "#fff" };

  it("rejects a scene whose elements aren't an array", () => {
    expect(decodeScene(enc({ ...base, elements: "nope" }))).toBeNull();
  });

  it("drops malformed elements instead of returning them (they'd throw in the serializer)", () => {
    const good = {
      id: "g",
      type: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      stroke: "#000",
      strokeWidth: 2,
      fill: "none",
    };
    const decoded = decodeScene(
      enc({
        ...base,
        elements: [good, { type: "rect" }, { type: "bogus" }, { id: "x", type: "text" }],
      }),
    );
    expect(decoded?.elements).toEqual([good]);
    // The kept scene serializes without throwing.
    expect(() => sceneToSvg(decoded!)).not.toThrow();
  });

  it("a valid scene survives the filter unchanged", () => {
    const s = sceneWith(rect());
    expect(decodeScene(encodeScene(s))).toEqual(s);
  });
});

describe("freehandPathD edge cases", () => {
  it("returns empty for no points", () => {
    expect(freehandPathD([])).toBe("");
  });
  it("emits midpoint quadratics + a trailing line to the last point", () => {
    expect(freehandPathD([0, 0, 10, 0, 20, 10])).toBe("M 0 0 Q 10 0 15 5 L 20 10");
  });
});

// A minimal but realistic slide body: an unpositioned section with content and
// no existing overlay. In production `.slide{position:relative}` comes from theme
// CSS (absent in this bare-string fixture), and there's no inline position — so
// injectDrawOverlay adds one, which the position-guard test below relies on.
const SLIDE_HTML =
  '<section class="slide content-slide"><h1>Title</h1><p>Body</p></section>';

describe("sceneToOverlaySvg", () => {
  it("emits an absolutely-positioned, non-interactive overlay carrying the scene", () => {
    const svg = sceneToOverlaySvg(sceneWith(rect()));
    expect(svg).toContain(`class="${DRAW_OVERLAY_CLASS}"`);
    expect(svg).toContain("position:absolute");
    expect(svg).toContain("pointer-events:none");
    expect(svg).toContain("data-canvas-scene=");
    expect(svg).toContain("<rect ");
    // Never paints a background rect — the slide shows through.
    expect(svg).not.toContain('width="1280" height="720" fill=');
  });
});

describe("injectDrawOverlay / stripDrawOverlay", () => {
  it("appends the overlay as the last child inside the section", () => {
    const out = injectDrawOverlay(SLIDE_HTML, sceneWith(rect()));
    expect(hasDrawOverlayHtml(out)).toBe(true);
    // Original content is preserved, overlay sits right before </section>.
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toMatch(new RegExp(`<svg class="${DRAW_OVERLAY_CLASS}"[\\s\\S]*</svg></section>$`));
  });

  it("adds position:relative only when the section has no inline position", () => {
    const out = injectDrawOverlay(SLIDE_HTML, sceneWith(rect()));
    expect(out).toContain('style="position:relative"');
    // An explicit inline position is never overridden.
    const absolute = '<section class="slide" style="position:absolute;top:0">x</section>';
    const outAbs = injectDrawOverlay(absolute, sceneWith(rect()));
    expect(outAbs).toContain("position:absolute;top:0");
    expect(outAbs).not.toContain("position:relative");
  });

  it("re-saving replaces the overlay rather than stacking layers", () => {
    const once = injectDrawOverlay(SLIDE_HTML, sceneWith(rect()));
    const twice = injectDrawOverlay(once, sceneWith(rect({ id: "r2" } as Partial<DrawElement>)));
    expect((twice.match(new RegExp(DRAW_OVERLAY_CLASS, "g")) ?? []).length).toBe(1);
  });

  it("an empty scene strips the overlay back to a clean slide", () => {
    const withOverlay = injectDrawOverlay(SLIDE_HTML, sceneWith(rect()));
    const cleared = injectDrawOverlay(withOverlay, emptyScene("transparent"));
    expect(hasDrawOverlayHtml(cleared)).toBe(false);
    expect(cleared).toContain("<h1>Title</h1>");
  });

  it("the injected overlay round-trips back to the editable scene", () => {
    const scene = sceneWith(rect());
    const out = injectDrawOverlay(SLIDE_HTML, scene);
    const recovered = parseSceneFromHtml(out);
    expect(recovered?.elements).toEqual(scene.elements);
  });

  it("stripDrawOverlay leaves a plain slide untouched", () => {
    expect(stripDrawOverlay(SLIDE_HTML)).toBe(SLIDE_HTML);
  });

  // The central safety property: overlay strip/inject must never disturb OTHER
  // SVGs in the slide (a chart, an inlined logo). A greedy-regex regression would
  // silently delete them on every save.
  it("never swallows an unrelated <svg>, in either order", () => {
    const before = '<section class="slide"><svg class="chart"><rect/></svg><h1>Hi</h1></section>';
    const injected = injectDrawOverlay(before, sceneWith(rect()));
    expect(injected).toContain('<svg class="chart">');
    const stripped = stripDrawOverlay(injected);
    expect(stripped).toContain('<svg class="chart">');
    expect(hasDrawOverlayHtml(stripped)).toBe(false);

    // Unrelated svg AFTER the overlay must also survive a strip.
    const overlayFirst =
      `<section class="slide">${sceneToOverlaySvg(sceneWith(rect()))}<svg class="logo"></svg></section>`;
    const s2 = stripDrawOverlay(overlayFirst);
    expect(s2).toContain('<svg class="logo">');
    expect(hasDrawOverlayHtml(s2)).toBe(false);
  });

  it("handles a '>' inside a section attribute value without dropping the slide's own style", () => {
    const tricky = '<section class="slide" data-note="a > b" style="color:red">x</section>';
    const out = injectDrawOverlay(tricky, sceneWith(rect()));
    // The bug this pins: a naive `[^>]*` match truncates at the `>` in data-note,
    // then prepends a SECOND style attr, and the browser drops color:red. Correct
    // behaviour merges into the one style value and preserves the attribute.
    expect(out).toContain("position:relative;color:red");
    expect(out).toContain('data-note="a > b"');
    expect(hasDrawOverlayHtml(out)).toBe(true);
  });

  it("merges into a single-quoted style attribute (no duplicate style attr)", () => {
    const single = "<section class='slide' style='color:blue'>x</section>";
    const out = injectDrawOverlay(single, sceneWith(rect()));
    expect(out).toContain("position:relative;color:blue");
  });

  it("positions and injects into the SAME (outer) section when sections nest", () => {
    const nested =
      '<section class="slide"><div><section class="inner">deep</section></div></section>';
    const out = injectDrawOverlay(nested, sceneWith(rect()));
    // Overlay is the last child of the OUTER section (right before its close).
    expect(out).toMatch(new RegExp(`<svg class="${DRAW_OVERLAY_CLASS}"[\\s\\S]*</svg></section>$`));
    // The inline position lands on the outer section, not the inner one.
    expect(out).toMatch(/^<section[^>]*position:relative/);
    expect(out).toContain('<section class="inner">deep</section>');
  });

  it("leaves an already-inline-positioned section's position untouched", () => {
    const absolute = '<section class="slide" style="position:absolute;top:0">x</section>';
    const out = injectDrawOverlay(absolute, sceneWith(rect()));
    expect(out).toContain("position:absolute;top:0");
    expect(out).not.toContain("position:relative");
  });

  it("falls back to appending when there is no <section> wrapper", () => {
    const out = injectDrawOverlay('<div class="slide">raw</div>', sceneWith(rect()));
    expect(out.startsWith('<div class="slide">raw</div>')).toBe(true);
    expect(hasDrawOverlayHtml(out)).toBe(true);
  });
});
