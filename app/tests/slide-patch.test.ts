import { describe, expect, it } from "vitest";
import {
  applySlidePatch,
  MAX_PATCH_EDITS,
  type SlidePatchEdit,
} from "../src/lib/canvas/slide-patch";

// applySlidePatch is the engine behind the propose_slide_patch MCP tool: it
// resolves find/replace snippets against a slide's current stored content so
// the client never has to resend the whole slide for a small adjustment. The
// resolved output is persisted as a normal whole-content slide_edit proposal,
// so correctness here IS the proposal's correctness.

const HTML = `<section class="slide"><h1>Revenue 2025</h1><p>Total: R$ 1.2M</p><p>Total: R$ 1.2M (projected)</p></section>`;
const CSS = `.slide h1 { color: #102a43; } .slide p { font-size: 18px; }`;

const current = { html_body: HTML, slide_styles: CSS };

const edit = (over: Partial<SlidePatchEdit> = {}): SlidePatchEdit => ({
  find: "Revenue 2025",
  replace: "Revenue 2026",
  ...over,
});

describe("applySlidePatch", () => {
  it("replaces a unique snippet in html_body and leaves styles untouched", () => {
    const r = applySlidePatch(current, [edit()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html_body).toContain("Revenue 2026");
    expect(r.html_body).not.toContain("Revenue 2025");
    expect(r.slide_styles).toBe(CSS);
    expect(r.touched).toEqual({ html_body: true, slide_styles: false });
  });

  it("patches slide_styles when in='slide_styles'", () => {
    const r = applySlidePatch(current, [
      edit({ find: "font-size: 18px", replace: "font-size: 20px", in: "slide_styles" }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slide_styles).toContain("font-size: 20px");
    expect(r.html_body).toBe(HTML);
    expect(r.touched).toEqual({ html_body: false, slide_styles: true });
  });

  it("rejects an ambiguous find (multiple occurrences, no replace_all)", () => {
    const r = applySlidePatch(current, [edit({ find: "Total: R$ 1.2M" })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("matches 2 places");
  });

  it("replace_all rewrites every occurrence", () => {
    const r = applySlidePatch(current, [
      edit({ find: "R$ 1.2M", replace: "R$ 1.4M", replace_all: true }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html_body.split("R$ 1.4M").length - 1).toBe(2);
    expect(r.html_body).not.toContain("R$ 1.2M");
  });

  it("reports not-found with a read_slide hint", () => {
    const r = applySlidePatch(current, [edit({ find: "Revenue 2024" })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("not found in html_body");
    expect(r.error).toContain("read_slide");
  });

  it("applies edits in order — later finds see earlier output", () => {
    const r = applySlidePatch(current, [
      edit({ find: "Revenue 2025", replace: "Receita 2025" }),
      edit({ find: "Receita 2025", replace: "Receita 2026" }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html_body).toContain("Receita 2026");
  });

  it("an empty replace deletes the found text", () => {
    const r = applySlidePatch(current, [edit({ find: " (projected)", replace: "" })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html_body).not.toContain("(projected)");
  });

  it("does not interpret $-patterns in the replacement (no String.replace semantics)", () => {
    const r = applySlidePatch(current, [edit({ replace: "Revenue $& $1 2026" })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html_body).toContain("Revenue $& $1 2026");
  });

  it("rejects a no-op patch (replace equals find)", () => {
    const r = applySlidePatch(current, [edit({ replace: "Revenue 2025" })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no changes");
  });

  it("rejects an empty edits array and an empty find", () => {
    expect(applySlidePatch(current, []).ok).toBe(false);
    const r = applySlidePatch(current, [edit({ find: "" })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"find" must be non-empty');
  });

  it("rejects more than MAX_PATCH_EDITS edits", () => {
    const many = Array.from({ length: MAX_PATCH_EDITS + 1 }, () => edit());
    const r = applySlidePatch(current, many);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("too many edits");
  });

  it("the not-found error names the edit's 1-based index", () => {
    const r = applySlidePatch(current, [edit(), edit({ find: "nope" })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("edit #2");
  });
});
