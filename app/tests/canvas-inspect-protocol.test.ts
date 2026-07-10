import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { assembleDeckHtml } from "@/lib/canvas/assemble";

/**
 * Functional tests for the direct-manipulation inspector (CANVAS_EDITOR's
 * inspect mode). The string-presence checks in canvas-assemble.test.ts prove
 * the protocol ships; these run the assembled preview page in jsdom and
 * exercise the actual select → set-style → nudge → save round-trip.
 *
 * In a standalone jsdom document `window.parent === window`, so the script's
 * postMessage replies land on the same window — the tests just listen there.
 */

// #block carries an explicit inline size: jsdom does no layout, so the resize
// tests' base width/height must resolve from computed (inline) style.
const SLIDE = `<section class="slide"><div id="block" style="font-size: 24px; color: rgb(255, 0, 0); position: absolute; left: 100px; top: 50px; width: 50px; height: 30px;"><p id="inner">Hello</p></div></section>`;

function createPreview() {
  const html = assembleDeckHtml({
    title: "t",
    theme_css: "",
    nav_js: "",
    slides: [{ position: 0, title: "t", html_body: SLIDE, slide_styles: null }],
    mode: "preview",
  });
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const messages: Array<Record<string, unknown>> = [];
  win.addEventListener("message", (e) => {
    const data = (e as MessageEvent).data;
    if (data && typeof data.type === "string" && data.type.startsWith("canvas:")) {
      messages.push(data);
    }
  });
  return { win, messages };
}

// jsdom delivers postMessage asynchronously. Two ticks: one to deliver the
// host's message to the script, one more for the script's postMessage reply
// to reach the test listener.
async function flush(win: Window) {
  await new Promise((r) => win.setTimeout(r as () => void, 0));
  await new Promise((r) => win.setTimeout(r as () => void, 0));
}

async function startAndSelect(
  win: Window & typeof globalThis,
  messages: Array<Record<string, unknown>>,
  id: string,
) {
  win.postMessage({ type: "canvas:inspect-start", position: 0 }, "*");
  await flush(win);
  const el = win.document.getElementById(id)!;
  el.dispatchEvent(
    new win.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await flush(win);
  return el;
}

describe("CANVAS_EDITOR inspect mode (jsdom round-trip)", () => {
  it("enters inspect mode and reports a selection with a style snapshot", async () => {
    const { win, messages } = createPreview();
    const block = await startAndSelect(win, messages, "block");

    expect(
      messages.some((m) => m.type === "canvas:inspect-ready" && m.ok === true),
    ).toBe(true);

    const sel = messages.find((m) => m.type === "canvas:element-selected") as
      | { descriptor: string; styles: Record<string, unknown> }
      | undefined;
    expect(sel).toBeTruthy();
    expect(sel!.descriptor).toBe("div#block");
    expect(sel!.styles.fontSize).toBe(24);
    expect(sel!.styles.color).toBe("#ff0000");
    expect(sel!.styles.positionMode).toBe("absolute");
    expect(sel!.styles.width).toBe(50);
    expect(sel!.styles.height).toBe(30);
    expect(block.getAttribute("data-canvas-inspect-selected")).toBe("true");
  });

  it("applies allowlisted styles only", async () => {
    const { win, messages } = createPreview();
    const block = await startAndSelect(win, messages, "block");

    win.postMessage(
      {
        type: "canvas:inspect-set",
        styles: { "font-size": "32px", height: "40px", "z-index": "9999" },
      },
      "*",
    );
    await flush(win);
    expect(block.style.fontSize).toBe("32px");
    expect(block.style.height).toBe("40px");
    // Not in INSPECT_PROPS — must be ignored.
    expect(block.style.getPropertyValue("z-index")).toBe("");

    // null removes the property.
    win.postMessage(
      { type: "canvas:inspect-set", styles: { "font-size": null } },
      "*",
    );
    await flush(win);
    expect(block.style.getPropertyValue("font-size")).toBe("");
  });

  it("nudges an absolutely-positioned element via left/top", async () => {
    const { win, messages } = createPreview();
    const block = await startAndSelect(win, messages, "block");

    win.postMessage({ type: "canvas:inspect-nudge", dx: 5, dy: -2 }, "*");
    await flush(win);
    expect(block.style.left).toBe("105px");
    expect(block.style.top).toBe("48px");
  });

  it("nudges a flow element via transform: translate (no sibling reflow)", async () => {
    const { win, messages } = createPreview();
    const inner = await startAndSelect(win, messages, "inner");

    win.postMessage({ type: "canvas:inspect-nudge", dx: 3, dy: 4 }, "*");
    await flush(win);
    // Flow elements move with translate now (shared with drag), not margins, so
    // nudging never pushes siblings around.
    expect(inner.style.transform).toBe("translate(3px, 4px)");
    expect(inner.style.marginLeft).toBe("");
  });

  it("reselects the parent on canvas:inspect-parent", async () => {
    const { win, messages } = createPreview();
    await startAndSelect(win, messages, "inner");

    win.postMessage({ type: "canvas:inspect-parent" }, "*");
    await flush(win);
    const selections = messages.filter(
      (m) => m.type === "canvas:element-selected",
    );
    expect(selections.length).toBe(2);
    expect(selections[1].descriptor).toBe("div#block");
  });

  it("saves a clean slide: applied styles persist, markers are stripped", async () => {
    const { win, messages } = createPreview();
    await startAndSelect(win, messages, "block");

    win.postMessage(
      { type: "canvas:inspect-set", styles: { "font-size": "32px" } },
      "*",
    );
    await flush(win);
    win.postMessage({ type: "canvas:inspect-save", position: 0 }, "*");
    await flush(win);

    const saved = messages.find((m) => m.type === "canvas:slide-html") as
      | { html: string }
      | undefined;
    expect(saved).toBeTruthy();
    expect(saved!.html).toContain("font-size: 32px");
    expect(saved!.html).not.toContain("data-canvas-inspect-selected");
    expect(saved!.html).not.toContain("data-canvas-picking");
    expect(saved!.html).not.toContain("data-canvas-position");
  });

  // --- drag-to-reposition (Model A: free move, clamped to the slide) ---------
  // jsdom does no layout, so getBoundingClientRect/offsetWidth read 0 → the
  // stage scale is 1 and the clamp is inert unless a test stubs a layout in.

  function press(
    win: Window & typeof globalThis,
    target: Element,
    x: number,
    y: number,
  ) {
    target.dispatchEvent(
      new win.MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      }),
    );
  }
  function moveTo(
    win: Window & typeof globalThis,
    x: number,
    y: number,
    shift = false,
  ) {
    win.document.dispatchEvent(
      new win.MouseEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        shiftKey: shift,
      }),
    );
  }
  function release(win: Window & typeof globalThis) {
    win.document.dispatchEvent(
      new win.MouseEvent("pointerup", { bubbles: true, cancelable: true }),
    );
  }
  function rect(left: number, top: number, right: number, bottom: number) {
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON() {},
    } as unknown as DOMRect;
  }

  it("drags a flow element via transform once past the threshold", async () => {
    const { win, messages } = createPreview();
    const inner = await startAndSelect(win, messages, "inner");
    press(win, inner, 100, 100);
    moveTo(win, 140, 120);
    release(win);
    expect(inner.style.transform).toBe("translate(40px, 20px)");
    expect(inner.style.marginLeft).toBe("");
  });

  it("treats a sub-threshold press as a click, not a drag", async () => {
    const { win, messages } = createPreview();
    const inner = await startAndSelect(win, messages, "inner");
    press(win, inner, 100, 100);
    moveTo(win, 101, 101); // |1| + |1| = 2 < 3
    release(win);
    expect(inner.style.transform).toBe("");
  });

  it("drags an absolutely-positioned element via left/top", async () => {
    const { win, messages } = createPreview();
    const block = await startAndSelect(win, messages, "block"); // left:100 top:50
    press(win, block, 0, 0);
    moveTo(win, 30, 10);
    release(win);
    expect(block.style.left).toBe("130px");
    expect(block.style.top).toBe("60px");
  });

  it("clamps a drag so the element can't leave the slide", async () => {
    const { win, messages } = createPreview();
    const block = await startAndSelect(win, messages, "block");
    const section = win.document.querySelector(
      '[data-canvas-position="0"]',
    ) as HTMLElement;
    // Stub a real layout: stage 0..200 × 0..100; element 100..150 × 50..80.
    section.getBoundingClientRect = () => rect(0, 0, 200, 100);
    Object.defineProperty(section, "offsetWidth", {
      value: 200,
      configurable: true,
    });
    block.getBoundingClientRect = () => rect(100, 50, 150, 80);
    press(win, block, 120, 60);
    moveTo(win, 1000, 1000); // shove past the bottom-right corner
    release(win);
    // scale = 200/200 = 1; maxDx = 200-150 = 50; maxDy = 100-80 = 20.
    expect(block.style.left).toBe("150px");
    expect(block.style.top).toBe("70px");
  });

  it("swallows the click that trails a drag (no spurious reselect)", async () => {
    const { win, messages } = createPreview();
    const block = await startAndSelect(win, messages, "block");
    const before = messages.filter(
      (m) => m.type === "canvas:element-selected",
    ).length;
    press(win, block, 10, 10);
    moveTo(win, 60, 10);
    release(win);
    block.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush(win);
    const after = messages.filter(
      (m) => m.type === "canvas:element-selected",
    ).length;
    expect(after).toBe(before);
  });

  it("persists a dragged element's transform on save", async () => {
    const { win, messages } = createPreview();
    const inner = await startAndSelect(win, messages, "inner");
    press(win, inner, 0, 0);
    moveTo(win, 25, 15);
    release(win);
    win.postMessage({ type: "canvas:inspect-save", position: 0 }, "*");
    await flush(win);
    const saved = messages.find((m) => m.type === "canvas:slide-html") as
      | { html: string }
      | undefined;
    expect(saved!.html).toContain("translate(25px, 15px)");
    expect(saved!.html).not.toContain("data-canvas-inspect-selected");
  });

  // --- drag-to-resize (8 grips on the selection, clamped like a move) --------
  // Same jsdom caveat: rects read 0 unless a test stubs a layout in, and the
  // base width/height resolve from #block's inline style.

  async function selectBlockWithLayout(
    win: Window & typeof globalThis,
    messages: Array<Record<string, unknown>>,
  ) {
    const block = await startAndSelect(win, messages, "block");
    const section = win.document.querySelector(
      '[data-canvas-position="0"]',
    ) as HTMLElement;
    // Stage 0..200 × 0..100 at scale 1; #block on screen at 100..150 × 50..80
    // (matches its inline left/top/width/height).
    section.getBoundingClientRect = () => rect(0, 0, 200, 100);
    Object.defineProperty(section, "offsetWidth", {
      value: 200,
      configurable: true,
    });
    block.getBoundingClientRect = () => rect(100, 50, 150, 80);
    return block;
  }

  function grip(win: Window & typeof globalThis, name: string) {
    return win.document.querySelector(
      `[data-canvas-handle="${name}"]`,
    ) as HTMLElement;
  }

  it("shows 8 resize grips outside the slide section, hidden on deselect", async () => {
    const { win, messages } = createPreview();
    await startAndSelect(win, messages, "block");
    const grips = win.document.querySelectorAll("[data-canvas-handle]");
    expect(grips.length).toBe(8);
    const section = win.document.querySelector('[data-canvas-position="0"]')!;
    for (const g of Array.from(grips)) expect(section.contains(g)).toBe(false);

    win.postMessage({ type: "canvas:inspect-deselect" }, "*");
    await flush(win);
    const layer = win.document.querySelector(
      "[data-canvas-handles]",
    ) as HTMLElement;
    expect(layer.style.display).toBe("none");
  });

  it("resizes width/height from the se grip without moving the element", async () => {
    const { win, messages } = createPreview();
    const block = await selectBlockWithLayout(win, messages);
    press(win, grip(win, "se"), 150, 80);
    moveTo(win, 170, 95);
    release(win);
    expect(block.style.width).toBe("70px");
    expect(block.style.height).toBe("45px");
    expect(block.style.left).toBe("100px"); // a resize never moves the anchor
    expect(block.style.transform).toBe("");

    // The finished gesture re-posts the snapshot so the host panel's size
    // fields track the new box.
    await flush(win);
    const sels = messages.filter((m) => m.type === "canvas:element-selected");
    const last = sels[sels.length - 1] as {
      styles: { width: number; height: number };
    };
    expect(last.styles.width).toBe(70);
    expect(last.styles.height).toBe(45);
  });

  it("re-anchors the left edge when resizing an absolute element from the w grip", async () => {
    const { win, messages } = createPreview();
    const block = await selectBlockWithLayout(win, messages);
    press(win, grip(win, "w"), 100, 60);
    moveTo(win, 90, 60);
    release(win);
    expect(block.style.width).toBe("60px");
    expect(block.style.left).toBe("90px"); // opposite (east) edge stays put
  });

  it("locks the aspect ratio with Shift on a corner grip", async () => {
    const { win, messages } = createPreview();
    const block = await selectBlockWithLayout(win, messages);
    press(win, grip(win, "se"), 150, 80);
    moveTo(win, 175, 80, true); // dx=+25 is the dominant axis (sx = 1.5)
    release(win);
    expect(block.style.width).toBe("75px");
    expect(block.style.height).toBe("45px"); // 30 × 1.5
  });

  it("clamps a grip drag to the slide bounds", async () => {
    const { win, messages } = createPreview();
    const block = await selectBlockWithLayout(win, messages);
    press(win, grip(win, "se"), 150, 80);
    moveTo(win, 1000, 1000); // shove past the bottom-right corner
    release(win);
    // maxDx = 200 - 150 = 50; maxDy = 100 - 80 = 20
    expect(block.style.width).toBe("100px");
    expect(block.style.height).toBe("50px");
  });

  it("saves a resized slide without grip artifacts", async () => {
    const { win, messages } = createPreview();
    await selectBlockWithLayout(win, messages);
    press(win, grip(win, "se"), 150, 80);
    moveTo(win, 170, 95);
    release(win);
    win.postMessage({ type: "canvas:inspect-save", position: 0 }, "*");
    await flush(win);
    const saved = messages.find((m) => m.type === "canvas:slide-html") as
      | { html: string }
      | undefined;
    expect(saved!.html).toContain("width: 70px");
    expect(saved!.html).toContain("height: 45px");
    expect(saved!.html).not.toContain("data-canvas-handle");
  });
});
