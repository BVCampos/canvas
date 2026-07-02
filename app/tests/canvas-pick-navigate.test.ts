import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { assembleDeckHtml } from "@/lib/canvas/assemble";

/**
 * Regression test for the "point to an element" (pick) flow in CANVAS_EDITOR.
 *
 * Bug: starting a pick from the Ask-Claude composer while a proposal was being
 * compared (activeProposalId set) tore the crosshair down the instant it
 * appeared — "crosshair never starts". The host's startElementPick calls
 * clearProposalReview(), which flips activeProposalId; the navigate effect keys
 * on activeProposalId and re-posts canvas:navigate to the SAME slide. The
 * iframe treated ANY navigate as a pick-cancel, so the just-started pick was
 * cancelled. The fix: a navigate to the SAME slide must not cancel an in-flight
 * pick (only a navigate to a DIFFERENT slide means the user moved on).
 *
 * Same jsdom round-trip harness as canvas-inspect-protocol.test.ts: in a
 * standalone jsdom document window.parent === window, so the script's
 * postMessage replies land on the same window the test listens on.
 */

const TWO_SLIDES = [
  {
    position: 0,
    title: "one",
    html_body: `<section class="slide"><div id="block">Hello</div></section>`,
    slide_styles: null,
  },
  {
    position: 1,
    title: "two",
    html_body: `<section class="slide"><div id="block2">World</div></section>`,
    slide_styles: null,
  },
];

function createPreview() {
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
// host's message to the script, one more for the script's reply to land.
async function flush(win: Window) {
  await new Promise((r) => win.setTimeout(r as () => void, 0));
  await new Promise((r) => win.setTimeout(r as () => void, 0));
}

function pickingSection(win: Window & typeof globalThis): Element | null {
  return win.document.querySelector('[data-canvas-picking="true"]');
}

describe("CANVAS_EDITOR pick mode vs navigate (jsdom round-trip)", () => {
  it("enters pick mode on canvas:pick-start", async () => {
    const { win, messages } = createPreview();
    win.postMessage({ type: "canvas:pick-start", position: 0 }, "*");
    await flush(win);

    expect(
      messages.some((m) => m.type === "canvas:pick-ready" && m.ok === true),
    ).toBe(true);
    const sec = pickingSection(win);
    expect(sec).toBeTruthy();
    expect(sec!.querySelector("#block")).toBeTruthy();
  });

  it("keeps the pick alive on a SAME-slide navigate (the regression)", async () => {
    const { win } = createPreview();
    win.postMessage({ type: "canvas:pick-start", position: 0 }, "*");
    await flush(win);
    expect(pickingSection(win)).toBeTruthy();

    // clearProposalReview re-posts navigate to the slide we're already on.
    win.postMessage({ type: "canvas:navigate", position: 0 }, "*");
    await flush(win);

    // Crosshair must survive — this is what "crosshair never starts" was.
    expect(pickingSection(win)).toBeTruthy();

    // And a click still resolves to a picked element.
    win.document
      .getElementById("block")!
      .dispatchEvent(
        new win.MouseEvent("mousemove", { bubbles: true, cancelable: true }),
      );
    await flush(win);
    win.document
      .getElementById("block")!
      .dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await flush(win);
    // (picked round-trip proven by the chip; here we just confirm pick mode
    // was still live enough to clear itself on the click.)
    expect(pickingSection(win)).toBeNull();
  });

  it("cancels the pick on a DIFFERENT-slide navigate", async () => {
    const { win } = createPreview();
    win.postMessage({ type: "canvas:pick-start", position: 0 }, "*");
    await flush(win);
    expect(pickingSection(win)).toBeTruthy();

    // Switching slides means the pick (anchored to slide 0) is meaningless.
    win.postMessage({ type: "canvas:navigate", position: 1 }, "*");
    await flush(win);
    expect(pickingSection(win)).toBeNull();
  });

  it("cancels the pick on a navigate with no position (fallback)", async () => {
    const { win } = createPreview();
    win.postMessage({ type: "canvas:pick-start", position: 0 }, "*");
    await flush(win);
    expect(pickingSection(win)).toBeTruthy();

    win.postMessage({ type: "canvas:navigate" }, "*");
    await flush(win);
    expect(pickingSection(win)).toBeNull();
  });
});
