// Unit tests for the in-app assistant's composer prompt builders (ADR-0006).
//
// These pure functions expand a plain user instruction with the context the
// user is looking at, baked into the message `content` — the one channel BOTH
// runtimes read (the local bridge gets it verbatim; the OpenRouter runner loads
// it from history). buildSlideContextPrompt is what makes a plain message
// slide-aware: the regression we're guarding is "the agent doesn't know which
// slide I'm on" — it must carry the selected slide's id + a 1-based label and
// resolve "this slide"/"here" without pinning deck-wide asks to that slide.

import { describe, expect, it } from "vitest";
import {
  withBrandContext,
  buildPickedPrompt,
  buildSlideContextPrompt,
  describeComposedPrompt,
  type AssistantPickTarget,
  type AssistantSlideContext,
} from "../src/app/canvases/[id]/assistant-prompt";

const SLIDE: AssistantSlideContext = {
  slideId: "11111111-1111-1111-1111-111111111111",
  slidePosition: 0,
  slideTitle: "Café Carioca · Plano 2026",
};

describe("buildSlideContextPrompt", () => {
  it("carries the current slide id and a 1-based label, then the instruction", () => {
    const out = buildSlideContextPrompt(SLIDE, "add a background image here");
    // 0-based position renders as the human "slide 1".
    expect(out).toContain("slide 1");
    expect(out).toContain(`("${SLIDE.slideTitle}")`);
    expect(out).toContain(`slide_id ${SLIDE.slideId}`);
    // The instruction survives verbatim, on its own trailing line.
    expect(out.endsWith("add a background image here")).toBe(true);
  });

  it("resolves deixis but stays non-committal for deck-wide asks", () => {
    const out = buildSlideContextPrompt(SLIDE, "make the theme darker");
    expect(out).toContain('"this slide"');
    expect(out).toContain('"here"');
    // The hint explicitly yields to the user's words for deck-wide changes, so a
    // theme/reorder ask isn't wrongly pinned to the viewed slide.
    expect(out.toLowerCase()).toContain("deck-wide");
    expect(out).toContain("follow my words over this hint");
  });

  it("omits the title label when the slide is untitled", () => {
    const out = buildSlideContextPrompt(
      { ...SLIDE, slideTitle: null },
      "tighten the copy",
    );
    expect(out).toContain("slide 1 (slide_id");
    expect(out).not.toContain('("');
  });

  it("renders the right human number for a deeper slide", () => {
    const out = buildSlideContextPrompt({ ...SLIDE, slidePosition: 4 }, "x");
    expect(out).toContain("slide 5");
  });
});

describe("buildPickedPrompt (moved here from assistant-panel)", () => {
  const TARGET: AssistantPickTarget = {
    slideId: "22222222-2222-2222-2222-222222222222",
    slidePosition: 2,
    slideTitle: "A solução",
    descriptor: "h2#title.lead",
    html: "<h2 id=\"title\" class=\"lead\">Old</h2>",
  };

  it("anchors on the picked element and biases toward propose_slide_patch", () => {
    const out = buildPickedPrompt(TARGET, "make this bigger");
    expect(out).toContain("On slide 3 (\"A solução\")");
    expect(out).toContain(`slide_id ${TARGET.slideId}`);
    expect(out).toContain(TARGET.descriptor);
    expect(out).toContain("```html");
    expect(out).toContain(TARGET.html);
    expect(out).toContain("make this bigger");
    expect(out).toContain("propose_slide_patch");
  });

  it("truncates a large element so the chat bubble stays readable", () => {
    const big = "<div>" + "x".repeat(2000) + "</div>";
    const out = buildPickedPrompt({ ...TARGET, html: big }, "shrink it");
    expect(out).toContain("…truncated: large element.");
    // The anchor snippet is capped at 600 chars of the element's html.
    expect(out).not.toContain("x".repeat(700));
  });
});

describe("describeComposedPrompt (renders the composed prompt back quietly)", () => {
  // Scoped here (the other block's TARGET isn't in scope); mirrors that fixture.
  const TARGET: AssistantPickTarget = {
    slideId: "22222222-2222-2222-2222-222222222222",
    slidePosition: 2,
    slideTitle: "A solução",
    descriptor: "h2#title.lead",
    html: "<h2 id=\"title\" class=\"lead\">Old</h2>",
  };

  it("round-trips a slide-context prompt to a chip + the bare instruction", () => {
    const composed = buildSlideContextPrompt(SLIDE, "add a background image here");
    const { contextLabel, instruction, slideId } = describeComposedPrompt(composed);
    expect(contextLabel).toBe("Slide 1 · Café Carioca · Plano 2026");
    expect(instruction).toBe("add a background image here");
    // The chip links to the slide: the id is recovered for navigation…
    expect(slideId).toBe(SLIDE.slideId);
    // …but the raw slide_id never reaches what the user sees.
    expect(contextLabel).not.toContain(SLIDE.slideId);
  });

  it("labels an untitled slide with just its number", () => {
    const composed = buildSlideContextPrompt(
      { ...SLIDE, slideTitle: null },
      "tighten the copy",
    );
    expect(describeComposedPrompt(composed)).toEqual({
      contextLabel: "Slide 1",
      slideId: SLIDE.slideId,
      instruction: "tighten the copy",
    });
  });

  it("round-trips a picked-element prompt, dropping the HTML anchor + tool hint", () => {
    const composed = buildPickedPrompt(TARGET, "make this bigger");
    const { contextLabel, instruction, slideId } = describeComposedPrompt(composed);
    expect(contextLabel).toBe("Slide 3 · A solução · h2#title.lead");
    expect(instruction).toBe("make this bigger");
    // The picked element's slide_id is recovered for the chip link too.
    expect(slideId).toBe(TARGET.slideId);
    expect(instruction).not.toContain("```");
    expect(instruction).not.toContain("read_slide");
  });

  it("recovers the instruction even when the picked element was truncated", () => {
    const big = "<div>" + "x".repeat(2000) + "</div>";
    const composed = buildPickedPrompt({ ...TARGET, html: big }, "shrink it");
    expect(describeComposedPrompt(composed).instruction).toBe("shrink it");
  });

  it("passes a bare message through unchanged (no context folded in)", () => {
    expect(describeComposedPrompt("just punch up the title")).toEqual({
      contextLabel: null,
      slideId: null,
      instruction: "just punch up the title",
    });
  });

  it("yields a clean thread title (instruction only, no context preamble)", () => {
    // The thread switcher names a new conversation from this slice
    // (assistant-actions.ts / the panel's optimistic row) — it must be the
    // user's words, never the folded slide_id / context preamble.
    const composed = buildSlideContextPrompt(SLIDE, "make the headline punchier");
    const title = describeComposedPrompt(composed).instruction.slice(0, 80);
    expect(title).toBe("make the headline punchier");
    expect(title).not.toContain("Context —");
    expect(title).not.toContain("slide_id");
  });
});

describe("withBrandContext", () => {
  it("prepends the brand preamble and describeComposedPrompt strips it back off", () => {
    const composed = buildSlideContextPrompt(
      { slideId: "s-1", slidePosition: 3, slideTitle: "Pricing" },
      "tighten the headline",
    );
    const branded = withBrandContext("21x — colors: accent #2563eb · voice: direct", composed);
    expect(branded.startsWith("Workspace brand — 21x")).toBe(true);
    const display = describeComposedPrompt(branded);
    expect(display.instruction).toBe("tighten the headline");
    expect(display.contextLabel).toContain("Slide 4");
    expect(display.slideId).toBe("s-1");
  });

  it("is a no-op for a null or empty blurb", () => {
    expect(withBrandContext(null, "hello")).toBe("hello");
    expect(withBrandContext("", "hello")).toBe("hello");
  });

  it("keeps a bare branded message readable in the bubble", () => {
    const branded = withBrandContext("acme — colors: ink #111111", "make a title slide");
    const display = describeComposedPrompt(branded);
    expect(display.instruction).toBe("make a title slide");
    expect(display.contextLabel).toBeNull();
  });
});
