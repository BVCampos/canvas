import { describe, expect, it } from "vitest";
import { assembleDeckHtml, needsViewportShim } from "../src/lib/canvas/assemble";

// Smoke + invariants for assembleDeckHtml — the contract that the iframe
// preview, the export endpoint, and proposal-diff all depend on. Most of
// the surface area below exercises the embedded-host guard added when the
// platform took over carousel navigation from the deck's nav.js (see the
// EMBEDDED_GUARD docstring in src/lib/canvas/assemble.ts).

const DECK_NAV_JS = `
  const slidesEl = document.getElementById('slides');
  const total = document.querySelectorAll('.slide').length;
  let index = 0;
  function goTo(i) { index = i; slidesEl.style.transform = 'translateX(-' + (i*100) + 'vw)'; }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') goTo(index + 1);
    if (e.key === 'ArrowLeft') goTo(index - 1);
  });
  slidesEl.addEventListener('touchstart', function () {});
  slidesEl.addEventListener('touchend', function () {});
`.trim();

const THREE_SLIDES = [
  { position: 0, title: "A", html_body: `<section class="slide"><h1>A</h1></section>` },
  { position: 1, title: "B", html_body: `<section class="slide"><h1>B</h1></section>` },
  { position: 2, title: "C", html_body: `<section class="slide"><h1>C</h1></section>` },
];

describe("assembleDeckHtml — embedded-host guard", () => {
  it("injects EMBEDDED_GUARD before nav.js in preview mode", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    // Marker the guard sets on window — proves the guard script is present.
    expect(html).toContain("__canvasEmbedded");
    // The guard must run before the deck's nav.js, otherwise the deck's
    // top-level addEventListener calls escape the wrapper.
    const guardIdx = html.indexOf("__canvasEmbedded");
    const navIdx = html.indexOf("ArrowRight");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeGreaterThan(guardIdx);
  });

  it("omits EMBEDDED_GUARD in export mode (standalone deck needs its own keyboard)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).not.toContain("__canvasEmbedded");
    // Export chrome bundle is still inlined.
    expect(html).toContain("cv-chrome");
  });

  it("injects data-canvas-position even when the <section> tag has '>' in a quoted attribute", () => {
    // Regression: the opener regex used [^>]* and truncated at the first '>'
    // inside an attribute value, injecting data-canvas-position mid-attribute
    // and corrupting the slide — which breaks nav, the inspector, and PDF
    // pagination, all keyed off data-canvas-position.
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: "",
      slides: [
        {
          position: 0,
          title: "A",
          html_body: `<section class="slide" style="content:'a>b'"><h1>A</h1></section>`,
        },
      ],
      mode: "export",
    });
    // The position stamp lands as its own attribute AND the original style
    // attribute survives intact (not split at the inner '>').
    expect(html).toContain(`data-canvas-position="0"`);
    expect(html).toContain(`style="content:'a>b'"`);
  });

  it("defaults to preview mode when mode is omitted", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
    });
    expect(html).toContain("__canvasEmbedded");
  });

  it("skips EMBEDDED_GUARD for single-slide decks too — the carousel race only matters when there's >1 slide, but the guard is cheap and uniform", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: "",
      slides: [THREE_SLIDES[0]],
      mode: "preview",
    });
    // Guard is gated on mode, not slide count — it's still injected.
    expect(html).toContain("__canvasEmbedded");
    // But navChrome is suppressed for single-slide decks.
    expect(html).not.toContain('id="prevBtn"');
  });

  it("injects the inline-edit controller in preview mode (inert until canvas:edit-start)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    // Editor controller tokens — proves the script is present.
    expect(html).toContain("canvas:edit-start");
    expect(html).toContain("data-canvas-editing");
  });

  it("ships the element-pick protocol in preview mode (element-anchored prompts)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain("canvas:pick-start");
    expect(html).toContain("canvas:element-picked");
    expect(html).toContain("data-canvas-pick-hover");
    // The picked message carries the element's viewport rect so the host can
    // anchor its "prompt copied" popover on the element itself. (Other scripts
    // also call getBoundingClientRect, so assert the message field instead.)
    expect(html).toContain("rect: { x: r.x");
  });

  it("ships the inspect protocol in preview mode (direct-manipulation inspector)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain("canvas:inspect-start");
    expect(html).toContain("canvas:element-selected");
    expect(html).toContain("canvas:inspect-save");
    expect(html).toContain("data-canvas-inspect-selected");
  });

  it("ships the inspect-text protocol in preview mode (double-click to edit text)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    // Host-initiated text edit, the in-iframe double-click handler, the live
    // editing marker, and the state round-trip the host hint keys on.
    expect(html).toContain("canvas:inspect-text");
    expect(html).toContain("canvas:inspect-text-state");
    expect(html).toContain("data-canvas-text-editing");
    expect(html).toContain("onInspectDblClick");
    // The text edit must serialize INTO the slide HTML on save — the editing
    // markers are stripped so the stored body stays clean (no contenteditable).
    expect(html).toContain("data-canvas-text-editing]");
  });

  it("omits the inspect-text protocol in export mode (read-only standalone deck)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).not.toContain("canvas:inspect-text");
    expect(html).not.toContain("data-canvas-text-editing");
  });

  it("omits the inline-edit controller in export mode (standalone deck stays read-only)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).not.toContain("canvas:edit-start");
    expect(html).not.toContain("canvas:pick-start");
    expect(html).not.toContain("canvas:inspect-start");
  });
});

describe("assembleDeckHtml — export print stylesheet (Save-as-PDF)", () => {
  // The exported deck is a single-viewport carousel; without a print
  // stylesheet, "Export HTML" → "Save as PDF" collapsed every deck to ONE
  // US-Letter-portrait page of slide 1. These lock in the fix: a 16:9
  // landscape @page, one slide per page, and no leakage into preview/screen.
  it("injects a print-scoped stylesheet in export mode", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).toContain('<style media="print">');
    // 16:9 landscape page box — and crucially WITHOUT the invalid `landscape`
    // keyword, which silently reverts Chrome to Letter portrait.
    expect(html).toContain("@page { size: 1280px 720px; margin: 0; }");
    expect(html).not.toContain("1280px 720px landscape");
    // One slide per page + the trailing-blank-page guard.
    expect(html).toContain("break-after: page");
    expect(html).toContain("[data-canvas-position]:last-child");
    // Backgrounds preserved for dark decks.
    expect(html).toContain("print-color-adjust: exact");
  });

  it("omits the print stylesheet entirely in preview mode (live editor unaffected)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain('<style media="print">');
    expect(html).not.toContain("@page");
  });

  it("ships the print stylesheet for single-slide decks too (must still paginate as one sized page)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: "",
      slides: [{ position: 0, title: "Only", html_body: `<section class="slide"><h1>Only</h1></section>` }],
      mode: "export",
    });
    // Export *chrome* is gated on >1 slide, but the print stylesheet is not.
    expect(html).toContain('<style media="print">');
    expect(html).toContain("@page { size: 1280px 720px; margin: 0; }");
  });

  it("emits the print stylesheet after theme_css so it wins the cascade", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".my-theme-marker {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html.indexOf(".my-theme-marker")).toBeLessThan(
      html.indexOf('<style media="print">'),
    );
  });

  it("hides screen-only interactive chrome in print (edit hints, deck-chrome wrapper)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    // Seed Claude decks bake `.edit-hint` chips into slide bodies and ship an
    // autosave "Restaurar original" button as body chrome — both printed onto
    // cover slides until the hide-list covered them.
    expect(html).toContain(".edit-hint");
    expect(html).toContain('[data-canvas="deck-chrome"] { display: none !important; }');
  });

  it("ships the print-fit script in export mode only (single-slide decks included)", () => {
    const exported = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: "",
      slides: [{ position: 0, title: "Only", html_body: `<section class="slide"><h1>Only</h1></section>` }],
      mode: "export",
    });
    // beforeprint/afterprint wiring for the manual Cmd+P path, plus the
    // explicit hook the PDF route calls (headless printToPDF fires no event).
    expect(exported).toContain("__canvasPrintFit");
    expect(exported).toContain("beforeprint");
    expect(exported).toContain("afterprint");

    const preview = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(preview).not.toContain("__canvasPrintFit");
  });
});

describe("assembleDeckHtml — CANVAS_CONTROLLER navigate is direct DOM", () => {
  it("controller writes the slides transform directly, not via dispatched events or dot clicks", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    // Look at the controller body — direct DOM mutation is the new
    // navigation primitive.
    expect(html).toContain("slidesEl.style.transform = 'translateX(-'");
    // Old strategies that caused the race must be gone.
    expect(html).not.toContain("dots[target].click()");
    expect(html).not.toContain("dispatchEvent(new KeyboardEvent");
  });

  it("controller forwards arrow / Space / PageUp / PageDown / Home / End to the host via canvas:key", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain("canvas:key");
    expect(html).toContain("FORWARD_KEYS");
  });
});

describe("assembleDeckHtml — hidden nav stubs survive both modes", () => {
  it("preview mode renders hidden navbar stubs for deck nav.js compatibility", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain('id="prevBtn"');
    expect(html).toContain('id="nextBtn"');
    expect(html).toContain('id="dotsNav"');
    expect(html).toContain('id="current"');
    expect(html).toContain('id="total"');
    // Hidden inline so deck CSS can't accidentally re-show.
    expect(html).toContain('class="navbar"');
    expect(html).toContain("display:none !important");
  });

  it("export mode also renders the hidden navbar (deck nav.js binds to it via getElementById)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).toContain('id="prevBtn"');
    expect(html).toContain("display:none !important");
  });
});

describe("assembleDeckHtml — data-canvas-position injection", () => {
  it("tags each <section> with its 0-indexed position", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: "",
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain('data-canvas-position="0"');
    expect(html).toContain('data-canvas-position="1"');
    expect(html).toContain('data-canvas-position="2"');
  });
});

// Coverage for the viewport shim that rebinds fixed-pixel / wrapper-dependent
// decks (standalone exports, PPTX conversions) onto Canvas's
// `.deck > #slides > .slide` viewport-unit model. The bug it guards: a deck
// whose `.slide` is hard-sized in px (`width:1280px;height:720px`) inside
// `.stage-area/.viewport/.track` wrappers the parser strips renders blank —
// only the top-left of slide 1 shows and nav can't scroll. The shim only fires
// for that signature; Canvas-native decks (`.slide{flex:0 0 100vw}`) are left
// byte-for-byte alone.
describe("needsViewportShim — fixed-px detection", () => {
  it("flags a fixed-pixel standalone deck (width + flex in px)", () => {
    expect(
      needsViewportShim(".slide{flex:0 0 1280px;width:1280px;height:720px;}"),
    ).toBe(true);
  });

  it("leaves a Canvas-native viewport-unit deck untouched", () => {
    expect(needsViewportShim(".slide{flex:0 0 100vw;height:100%;}")).toBe(false);
  });

  it("does not trip on max-width / min-width (those aren't the slide's box width)", () => {
    // A viewport-unit slide that merely caps an inner column in px must not be
    // mistaken for a fixed-px slide.
    expect(
      needsViewportShim(".slide{flex:0 0 100vw;} .sub{max-width:1020px;}"),
    ).toBe(false);
  });

  it("ignores a blank-template deck with no slide sizing (handled as a scroll stack)", () => {
    expect(needsViewportShim("")).toBe(false);
    expect(needsViewportShim(".slide{padding:24px;}")).toBe(false);
  });
});

describe("assembleDeckHtml — viewport shim injection", () => {
  const FIXED_PX_THEME =
    ".slide{flex:0 0 1280px;width:1280px;height:720px;overflow:hidden;}";

  it("injects the shim for a fixed-px deck, after theme_css so it wins the cascade", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: FIXED_PX_THEME,
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain('data-canvas="viewport-shim"');
    expect(html).toContain("flex: 0 0 100vw");
    // Higher-specificity rebind so it beats the deck's own .slide rule.
    expect(html).toContain("#slides > .slide");
    // Must come AFTER the deck's theme so the cascade resolves to the shim.
    expect(html.indexOf(FIXED_PX_THEME)).toBeLessThan(
      html.indexOf('data-canvas="viewport-shim"'),
    );
  });

  it("omits the shim for a Canvas-native viewport-unit deck", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".deck{width:100vw}.slides{display:flex}.slide{flex:0 0 100vw}",
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain('data-canvas="viewport-shim"');
  });

  it("also injects the shim in export mode (a standalone fixed-px deck is broken the same way)", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: FIXED_PX_THEME,
      nav_js: DECK_NAV_JS,
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).toContain('data-canvas="viewport-shim"');
  });
});

// Behavioral coverage for the layout-aware navigate(). The controller is a
// string injected into the iframe, so we extract the *real* shipped script and
// run it against a hand-rolled fake DOM where we control each section's
// offsetLeft. The bug this guards: a blank/create_deck deck (minimal theme,
// empty nav.js) stacks its slides vertically with no horizontal flex strip, so
// driving it with translateX(-N*100vw) shoves the whole column off-screen and
// every slide past the first renders blank. The fix decides carousel-vs-scroll
// by measuring the layout instead of assuming `#slides` is always a carousel.

// Pull the CANVAS_CONTROLLER `<script>` body out of the assembled HTML —
// identified by a token only it contains.
function extractController(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  const ctrl = scripts.find((s) => s.includes("isHorizontalStrip"));
  if (!ctrl) throw new Error("CANVAS_CONTROLLER script not found in output");
  return ctrl;
}

type FakeSlidesEl = { style: { transform: string }; querySelectorAll: () => unknown[] };
type ScrollCall = { pos: number; opts: unknown };

// Build a minimal DOM, run the controller in it, and return a `navigate(n)`
// that fires the `canvas:navigate` message the host would post. `offsetLefts`
// defines the layout: strictly-increasing → horizontal carousel; all-equal →
// vertical stack.
function runController(
  offsetLefts: number[],
  positions?: number[],
  layoutWidth?: number,
  renderScale?: number,
) {
  // `positions` lets a test give sections SPARSE DB positions (0,1,2,3,5,…)
  // that differ from their index — the contiguous default keeps the existing
  // callers unchanged.
  //
  // `layoutWidth` + `renderScale` model a CSS-zoom kit deck: each slide's layout
  // box is `layoutWidth` px (what offsetWidth + offsetLeft are reported in) but
  // it RENDERS at `layoutWidth * renderScale` (getBoundingClientRect().width).
  // Default (both undefined) → offsetWidth 0 / rect.width 0, which navigate()
  // reads as scale 1 (translate by raw offsetLeft) — the unscaled-deck behaviour
  // the existing callers assert.
  const pos = positions ?? offsetLefts.map((_, i) => i);
  const scrollCalls: ScrollCall[] = [];
  // Layout is mutable so a test can simulate the strip measuring AFTER an early
  // navigate() — the auto-entry race the ResizeObserver re-assert fixes.
  const offsets = [...offsetLefts];
  const ow = layoutWidth ?? 0;
  const rw = ow * (renderScale ?? 1);
  const sections = offsetLefts.map((_, i) => ({
    get offsetLeft() {
      return offsets[i];
    },
    offsetWidth: ow,
    getAttribute: (name: string) =>
      name === "data-canvas-position" ? String(pos[i]) : null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: rw, height: 0 }),
    scrollIntoView: (opts: unknown) => scrollCalls.push({ pos: pos[i], opts }),
    classList: { add() {}, remove() {} },
  }));

  const slidesEl: FakeSlidesEl = {
    style: { transform: "" },
    querySelectorAll: () => sections,
  };
  const byId: Record<string, unknown> = {
    slides: slidesEl,
    current: { textContent: "" },
    prevBtn: null,
    nextBtn: null,
  };

  const doc = {
    getElementById: (id: string) => (id in byId ? byId[id] : null),
    querySelector: (sel: string) => {
      // Match on the attribute VALUE (the slide's position), the way a real
      // browser does — NOT by array index. With sparse positions the two
      // differ, and conflating them is exactly the bug under test.
      const m = sel.match(/data-canvas-position="(\d+)"/);
      if (!m) return null;
      return (
        sections.find(
          (s) => s.getAttribute("data-canvas-position") === m[1],
        ) ?? null
      );
    },
    querySelectorAll: (sel: string) => {
      if (sel.includes("dotsNav")) return [];
      if (sel.includes("data-canvas-position") || sel.includes("section.slide"))
        return sections;
      return [];
    },
    documentElement: { clientWidth: 1280 },
  };

  const messageHandlers: Array<(e: { data: unknown }) => void> = [];
  const loadHandlers: Array<() => void> = [];
  const win = {
    innerWidth: 1280,
    parent: { postMessage: () => {} },
    addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
      if (type === "message") messageHandlers.push(fn);
      else if (type === "load") loadHandlers.push(fn as () => void);
    },
  };

  const html = assembleDeckHtml({
    title: "t",
    theme_css: "",
    nav_js: "",
    slides: offsetLefts.map((_, i) => ({
      position: i,
      title: String(i),
      html_body: `<section class="slide"><h1>${i}</h1></section>`,
    })),
    mode: "preview",
  });

  // Fake ResizeObserver: the controller observes the slide strip and re-asserts
  // navigate() when layout settles. We capture its callback so a test can fire a
  // "layout changed" notification on demand (triggerResize) after mutating the
  // offsets — modelling the strip measuring a frame or two after the early
  // navigate(). observe/disconnect are no-ops; only the callback matters here.
  let roCallback: (() => void) | null = null;
  class FakeResizeObserver {
    constructor(cb: () => void) {
      roCallback = cb;
    }
    observe() {}
    disconnect() {}
  }

  // requestAnimationFrame / setTimeout are no-ops: we only assert the
  // synchronous transform / scroll decision, not the async bounds broadcast.
  const noop = () => 0;
  new Function(
    "window",
    "document",
    "requestAnimationFrame",
    "setTimeout",
    "ResizeObserver",
    extractController(html),
  )(win, doc, noop, noop, FakeResizeObserver);

  const navigate = (position: number) => {
    for (const fn of messageHandlers)
      fn({ data: { type: "canvas:navigate", position } });
  };

  // Fire the window 'load' event the controller listens for.
  const fireLoad = () => {
    for (const fn of loadHandlers) fn();
  };

  // Mutate the strip's layout, then notify the controller's ResizeObserver —
  // the two halves of "the strip just measured".
  const setOffsets = (next: number[]) => {
    for (let i = 0; i < next.length; i++) offsets[i] = next[i];
  };
  const triggerResize = () => {
    if (roCallback) roCallback();
  };

  return { navigate, fireLoad, setOffsets, triggerResize, slidesEl, scrollCalls };
}

describe("assembleDeckHtml — CANVAS_CONTROLLER is layout-aware", () => {
  it("horizontal carousel deck navigates by translateX", () => {
    const { navigate, slidesEl, scrollCalls } = runController([0, 1280, 2560]);
    navigate(2);
    // Translate by the slide's actual layout offset (2560px). For a
    // viewport-width strip that equals index*100vw, so this is unchanged for
    // native decks — see the fixed-width deck test below for why offsetLeft
    // (not 100vw) is the source of truth.
    expect(slidesEl.style.transform).toBe("translateX(-2560px)");
    // A real strip moves via transform — no scrolling.
    expect(scrollCalls).toHaveLength(0);
  });

  it("vertically-stacked deck navigates by scrollIntoView, not translateX", () => {
    const { navigate, slidesEl, scrollCalls } = runController([0, 0, 0]);
    navigate(2);
    // The regression: translateX(-200vw) here would shove the whole stack
    // off-screen and render slide 3 blank. The fix scrolls instead.
    expect(scrollCalls).toEqual([
      { pos: 2, opts: { behavior: "instant", block: "start" } },
    ]);
    // And it must not leave a stale horizontal transform behind.
    expect(slidesEl.style.transform).toBe("");
  });

  it("gapped-position vertical deck scrolls to the slide whose position matches — not a count-clamped index", () => {
    // Real decks accumulate SPARSE positions (0,1,2,3,5,7,9,11,13,15) as slides
    // are inserted and deleted. The bug: navigate() clamped the target position
    // against the slide COUNT (10) and used it as an index, so every slide whose
    // position >= count (11, 13, 15) snapped to position 9 — "click the last
    // slide, watch it bounce to slide 7". The fix resolves the element by
    // position, so the last slide stays the last slide.
    const offsets = new Array(10).fill(0); // vertical stack, 10 slides
    const gapped = [0, 1, 2, 3, 5, 7, 9, 11, 13, 15];
    const { navigate, scrollCalls } = runController(offsets, gapped);
    navigate(15); // the last slide
    // Must scroll the section whose position is 15 (index 9) — NOT position 9
    // (index 6), which the old count-clamp produced.
    expect(scrollCalls).toEqual([
      { pos: 15, opts: { behavior: "instant", block: "start" } },
    ]);
  });

  it("gapped-position horizontal deck translates by the slide's layout offset, not raw position", () => {
    // Same sparsity on a real carousel: translateX must use the slide's actual
    // layout offset in the strip (index 9 → offsetLeft 11520px), not its raw
    // position (15 → off the end).
    const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i * 1280);
    const gapped = [0, 1, 2, 3, 5, 7, 9, 11, 13, 15];
    const { navigate, slidesEl, scrollCalls } = runController(offsets, gapped);
    navigate(15);
    expect(slidesEl.style.transform).toBe("translateX(-11520px)");
    expect(scrollCalls).toHaveLength(0);
  });

  it("fixed-width kit deck translates by offsetLeft, NOT index*100vw (blank-Lens regression)", () => {
    // Kit decks lay slides out at a fixed design width (1920px) inside a
    // zoom-scaled wrapper, so in a narrower preview viewport (1280px here) the
    // per-slide layout step (offsetLeft) is 1920px, NOT 100vw (1280px). The old
    // index*100vw under-translated and stranded higher-index slides off-screen
    // — a slide_create's new slide (index 2+) rendered fully blank in the Lens.
    // navigate must follow the real offsetLeft (3840px), not 2*100vw (2560px).
    const offsets = [0, 1920, 3840]; // 1920px-wide slides, 1280px viewport
    const { navigate, slidesEl, scrollCalls } = runController(offsets);
    navigate(2);
    expect(slidesEl.style.transform).toBe("translateX(-3840px)");
    expect(slidesEl.style.transform).not.toBe("translateX(-200vw)");
    expect(scrollCalls).toHaveLength(0);
  });

  it("CSS-zoom kit deck translates by the RENDERED offset, not raw (unzoomed) offsetLeft", () => {
    // The deck the live click-through caught: the Canvas importer forces slides to
    // 1920px !important and the kit's nav_js scales each with CSS `zoom`
    // (--slide-zoom = innerWidth/1920 ≈ 0.574). CSS zoom shrinks the RENDERED
    // width but Chrome still reports offsetLeft UNZOOMED (index*1920), so raw
    // offsetLeft over-translates by 1/zoom: navigate(8) on the real deck landed on
    // ~slide 14 (15360px vs the correct 8816px). navigate() must multiply
    // offsetLeft by the slide's render/layout ratio. Verified in-browser:
    // offsetLeft 15360 * (1102/1920) = 8816 puts the target at viewport x=0.
    // Here: layout 1920px slides rendered at half (zoom 0.5) → 3840 * 0.5 = 1920.
    const offsets = [0, 1920, 3840];
    const { navigate, slidesEl, scrollCalls } = runController(
      offsets,
      undefined,
      1920, // layout (offsetWidth) px
      0.5, // render scale (CSS zoom)
    );
    navigate(2);
    // Rendered offset, NOT raw offsetLeft (3840) and NOT index*100vw.
    expect(slidesEl.style.transform).toBe("translateX(-1920px)");
    expect(slidesEl.style.transform).not.toBe("translateX(-3840px)");
    expect(scrollCalls).toHaveLength(0);
  });

  it("re-asserts the scroll on window load, not just bounds (vertical decks settle layout after load)", () => {
    // The host posts canvas:navigate once on iframe load, but a doc-heavy /
    // vertical-stack deck reflows AFTER the load event (web-font swap, late
    // layout), stranding that initial scrollIntoView at a stale offset — the
    // target slide drifts up and the tail of the previous slide shows above it
    // ("two slides stacked on page 1"). The controller's window 'load' handler
    // must RE-ASSERT the scroll via navigate(), not merely re-emit position via
    // scheduleBounds() (which never scrolls). Guards assemble.ts:516.
    const { navigate, fireLoad, scrollCalls } = runController([0, 0, 0]);
    navigate(2); // host selects slide 3 → lastPosition = 2
    scrollCalls.length = 0; // ignore navigate's own scroll; observe load only
    fireLoad();
    // Re-asserts the CURRENT target (lastPosition=2) AND actually scrolls. The
    // old scheduleBounds(lastPosition) load handler left scrollCalls empty here.
    expect(scrollCalls).toEqual([
      { pos: 2, opts: { behavior: "instant", block: "start" } },
    ]);
  });

  it("re-asserts navigate when the strip measures AFTER navigate (ResizeObserver fixes blank auto-entry)", () => {
    // Auto-entry races layout: the host posts canvas:navigate while the flex
    // strip is still unmeasured (every offsetLeft 0). navigate() then can't place
    // the target — isHorizontalStrip() reads false at 0===0 and it scrolls a
    // carousel that doesn't scroll — so the preview is blank until a manual
    // Refresh. A ResizeObserver on the slide sections must re-run
    // navigate(lastPosition) the moment the strip gains real offsets. Guards the
    // observeStripLayout() re-assert in assemble.ts.
    const { navigate, setOffsets, triggerResize, slidesEl } = runController([
      0, 0, 0,
    ]);
    navigate(2); // host selects slide 3 BEFORE layout — every offsetLeft is 0
    // Pre-layout it's indistinguishable from a vertical stack, so no carousel
    // transform lands (the blank-preview symptom).
    expect(slidesEl.style.transform).toBe("");
    // Layout settles a frame later: the strip is a real 1920px-step carousel.
    setOffsets([0, 1920, 3840]);
    triggerResize();
    // The observer re-asserts navigate(2) with REAL offsets → the right slide.
    expect(slidesEl.style.transform).toBe("translateX(-3840px)");
  });

  it("ResizeObserver re-assert is deduped on the target's offsetLeft (no thrash on no-op callbacks)", () => {
    // The strip fires a burst of resize callbacks during initial layout; once the
    // target's offset is stable, further callbacks must NOT re-run navigate (which
    // would re-broadcast bounds and could fight rapid host navigation). We prove
    // dedup by checking a second trigger with unchanged geometry is inert.
    const { navigate, setOffsets, triggerResize, slidesEl } = runController([
      0, 0, 0,
    ]);
    navigate(2);
    setOffsets([0, 1920, 3840]);
    triggerResize();
    expect(slidesEl.style.transform).toBe("translateX(-3840px)");
    // Corrupt the transform, then fire a no-op resize (same offsets). Dedup must
    // short-circuit, so the controller does NOT overwrite our sentinel.
    slidesEl.style.transform = "SENTINEL";
    triggerResize();
    expect(slidesEl.style.transform).toBe("SENTINEL");
  });
});

describe("assembleDeckHtml — deck chrome (meta.chrome_html)", () => {
  const CHROME = `<div class="overlay" id="ov"><div class="modal" id="modalBox"></div></div>
<div class="dots" id="dots"></div>`;

  it("re-injects meta.chrome_html behind a data-canvas wrapper in preview mode", () => {
    const html = assembleDeckHtml({
      title: "Deck",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { chrome_html: CHROME },
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain('<div data-canvas="deck-chrome">');
    expect(html).toContain('id="modalBox"');
    expect(html).toContain('id="ov"');
  });

  it("re-injects chrome in export mode too (standalone file needs its modals)", () => {
    const html = assembleDeckHtml({
      title: "Deck",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { chrome_html: CHROME },
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).toContain('id="modalBox"');
  });

  it("hides deck-native nav rails inside the chrome wrapper via CSS, not removal", () => {
    const html = assembleDeckHtml({
      title: "Deck",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { chrome_html: CHROME },
      slides: THREE_SLIDES,
      mode: "preview",
    });
    // The dots rail must stay in the DOM (nav_js binds it by id) but be hidden.
    expect(html).toContain('id="dots"');
    expect(html).toContain('[data-canvas="deck-chrome"] .dots');
  });

  it("emits no chrome wrapper or style when meta has no chrome_html", () => {
    const html = assembleDeckHtml({
      title: "Deck",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: {},
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain('data-canvas="deck-chrome"');
  });

  it("strips contenteditable from injected chrome like it does for slides", () => {
    const html = assembleDeckHtml({
      title: "Deck",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { chrome_html: `<div id="ov" contenteditable="true">x</div>` },
      slides: THREE_SLIDES,
      mode: "preview",
    });
    // Scope the assertion to the chrome markup — the CANVAS_EDITOR runtime
    // script legitimately mentions the word "contenteditable".
    expect(html).toContain('<div id="ov">x</div>');
    expect(html).not.toContain('id="ov" contenteditable');
  });
});

// Preserved web-font links (parser.extractFontLinks → meta.font_links) must be
// re-emitted as <link rel="stylesheet"> in <head> so an imported deck keeps its
// font in Canvas. Both modes: preview needs the live stylesheet; export emits it
// too (the export route's font inliner replaces it with inline @font-face).
describe("assembleDeckHtml — preserved font links (meta.font_links)", () => {
  const HREF = "https://fonts.googleapis.com/css2?family=Inter:wght@400;700";

  it("re-emits a preserved font link in <head> in preview mode", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".foo {}",
      nav_js: DECK_NAV_JS,
      meta: { font_links: [HREF] },
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).toContain(`<link rel="stylesheet" href="${HREF}">`);
    // It sits in the head, before the deck's theme <style>.
    expect(html.indexOf(HREF)).toBeLessThan(html.indexOf(".foo {}"));
  });

  it("re-emits preserved font links in export mode too", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { font_links: [HREF] },
      slides: THREE_SLIDES,
      mode: "export",
    });
    expect(html).toContain(`<link rel="stylesheet" href="${HREF}">`);
  });

  it("emits no font <link> when meta has no font_links", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: {},
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it("escapes quotes in the href so a query string can't break out of the attribute", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { font_links: [`https://fonts.bunny.net/css?family=a"onload="x`] },
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain(`"onload="x`);
    expect(html).toContain("&quot;onload=");
  });

  it("ignores a non-array / non-string font_links value without throwing", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: DECK_NAV_JS,
      meta: { font_links: "not-an-array" as unknown as string[] },
      slides: THREE_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain('<link rel="stylesheet"');
  });
});
