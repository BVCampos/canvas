import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { assembleDeckHtml } from "@/lib/canvas/assemble";

/**
 * Regression test for "Export HTML gives you a cover you can't page past".
 *
 * Bug: the exported standalone file bundled CANVAS_CONTROLLER (whose navigate()
 * is the only code that moves the carousel) but it only ran in response to a
 * `canvas:navigate` postMessage from the Canvas host. In a downloaded file
 * there is no host — so pressing →, clicking the .cv-chrome Next button, and
 * the dots all fired but nothing moved. The visible counter even advanced while
 * the slide stayed on the cover (the export chrome bumped its own counter and
 * delegated the actual move to a controller that never navigated).
 *
 * Fix: export mode sets window.__canvasStandalone, the controller drives
 * navigate() itself on keydown, and exposes window.__canvasNavigate for the
 * .cv-chrome buttons/dots to call. The controller writes the hidden #current
 * stub on every move, so #current advancing to "2" is proof the REAL nav ran
 * (not just the visible chrome counter, which advanced even when broken).
 *
 * Same jsdom round-trip harness as canvas-pick-navigate.test.ts: in a
 * standalone jsdom document window.parent === window, so the export-mode
 * standalone flag governs the behaviour, not the frame topology.
 *
 * Positions are sparse (0 and 3) on purpose: navigate() keys on a slide's DB
 * position, not its index, so this also guards that mapping — slide two is at
 * position 3 but display index 1, and #current must read "2".
 */

const TWO_SLIDES = [
  {
    position: 0,
    title: "cover",
    html_body: `<section class="slide"><h1>Cover</h1></section>`,
    slide_styles: null,
  },
  {
    position: 3,
    title: "second",
    html_body: `<section class="slide"><h1>Second</h1></section>`,
    slide_styles: null,
  },
];

function createExport() {
  const html = assembleDeckHtml({
    title: "t",
    theme_css: "",
    nav_js: "", // host-driven deck: no standalone keyboard handler of its own
    slides: TWO_SLIDES,
    mode: "export",
  });
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window &
    typeof globalThis & { __canvasNavigate?: unknown };
  return { win };
}

async function flush(win: Window) {
  await new Promise((r) => win.setTimeout(r as () => void, 0));
  await new Promise((r) => win.setTimeout(r as () => void, 0));
}

const currentText = (win: Window & typeof globalThis) =>
  win.document.getElementById("current")?.textContent ?? null;

const chromeCounter = (win: Window & typeof globalThis) =>
  win.document.querySelector(".cv-chrome-counter strong")?.textContent ?? null;

describe("standalone export navigation (jsdom round-trip)", () => {
  it("exposes the controller and starts on slide 1", async () => {
    const { win } = createExport();
    await flush(win);
    expect(typeof win.__canvasNavigate).toBe("function");
    expect(currentText(win)).toBe("1");
  });

  it("advances to slide 2 on ArrowRight — no Canvas host present", async () => {
    const { win } = createExport();
    await flush(win);
    expect(currentText(win)).toBe("1");

    // Dispatch on body so it bubbles to BOTH the export-chrome document
    // listener (visible counter) and the controller's window listener (the
    // real move). Before the fix this only forwarded canvas:key to a parent
    // that isn't there, and #current stayed "1".
    win.document.body.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await flush(win);

    expect(currentText(win)).toBe("2"); // controller actually navigated
    expect(chromeCounter(win)).toBe("2"); // visible chrome stayed in sync
  });

  it("advances to slide 2 when the .cv-chrome Next button is clicked", async () => {
    const { win } = createExport();
    await flush(win);

    const next = win.document.querySelector<HTMLButtonElement>(
      '[aria-label="Next slide"]',
    );
    expect(next).toBeTruthy();
    next!.click();
    await flush(win);

    expect(currentText(win)).toBe("2");
    expect(chromeCounter(win)).toBe("2");
  });

  it("clamps at the ends (End then ArrowRight stays on slide 2)", async () => {
    const { win } = createExport();
    await flush(win);

    win.document.body.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await flush(win);
    expect(currentText(win)).toBe("2");

    win.document.body.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await flush(win);
    expect(currentText(win)).toBe("2"); // no phantom slide 3
  });
});

describe("preview navigation still forwards keys to the host", () => {
  it("does NOT self-navigate on keydown in preview mode", async () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: "",
      slides: TWO_SLIDES,
      mode: "preview",
    });
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    const keys: string[] = [];
    win.addEventListener("message", (e) => {
      const data = (e as MessageEvent).data;
      if (data && data.type === "canvas:key") keys.push(data.key);
    });
    await flush(win);

    win.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await flush(win);

    // Host owns navigation in preview: the controller forwards the key and
    // leaves #current where the host last set it (slide 1), rather than moving.
    expect(keys).toContain("ArrowRight");
    expect(win.document.getElementById("current")?.textContent).toBe("1");
  });
});

/**
 * Letterbox fit for standalone exports. Kit decks scale slides with
 * `.slide{zoom:var(--slide-zoom)}` and set --slide-zoom = innerWidth/1920
 * (width-fit only), so a window shorter than 16:9 crops the bottom of every
 * slide. Export mode injects a screen-only fit-both letterbox — but ONLY for
 * decks that use --slide-zoom, and never in preview or in the print path. The
 * runtime geometry needs real layout (jsdom has none), so these assert the
 * injection gating; the fit math is verified in a browser.
 */
const ZOOM_THEME = `.deck{position:relative}\n.slide{zoom:var(--slide-zoom,1)}`;

describe("standalone export letterbox fit (injection gating)", () => {
  it("injects the fit CSS + JS for a --slide-zoom deck in export mode", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ZOOM_THEME,
      nav_js: "",
      slides: TWO_SLIDES,
      mode: "export",
    });
    expect(html).toContain('data-canvas="export-fit"');
    expect(html).toContain("--cv-fit-w"); // the fit driver's stage sizing
    // Print path neutralizes the on-screen zoom so PDFs aren't shrunk.
    expect(html).toContain("zoom: 1 !important");
  });

  it("triggers on --slide-zoom in nav_js even if theme_css lacks it", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: "",
      nav_js: `document.documentElement.style.setProperty('--slide-zoom', innerWidth/1920)`,
      slides: TWO_SLIDES,
      mode: "export",
    });
    expect(html).toContain('data-canvas="export-fit"');
  });

  it("does NOT inject fit for a deck that never uses --slide-zoom", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ".slide{width:100vw}",
      nav_js: "",
      slides: TWO_SLIDES,
      mode: "export",
    });
    expect(html).not.toContain('data-canvas="export-fit"');
    expect(html).not.toContain("--cv-fit-w");
  });

  it("does NOT inject fit in preview mode", () => {
    const html = assembleDeckHtml({
      title: "t",
      theme_css: ZOOM_THEME,
      nav_js: "",
      slides: TWO_SLIDES,
      mode: "preview",
    });
    expect(html).not.toContain('data-canvas="export-fit"');
    expect(html).not.toContain("--cv-fit-w");
  });
});
