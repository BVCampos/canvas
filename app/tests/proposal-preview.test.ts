// previewProposalOnSlide — the one merge that the reviewer thumbnail and the
// render_proposal MCP tool both rely on, and that must match canvas_apply_edit's
// field-merge so a preview tells the truth about the eventual applied version.

import { describe, expect, it } from "vitest";
import { previewProposalOnSlide } from "../src/lib/canvas/proposal-preview";

const current = {
  title: "Cover",
  html_body: "<section class=\"slide\"><h1>Old</h1></section>",
  slide_styles: ".slide{color:black}",
};

describe("previewProposalOnSlide", () => {
  it("slide_html replaces only the html_body", () => {
    const out = previewProposalOnSlide(current, {
      kind: "slide_html",
      new_content: "<section class=\"slide\"><h1>New</h1></section>",
      new_slide_payload: null,
    });
    expect(out).toEqual({
      title: "Cover",
      html_body: "<section class=\"slide\"><h1>New</h1></section>",
      slide_styles: ".slide{color:black}",
    });
  });

  it("slide_styles replaces only the slide_styles", () => {
    const out = previewProposalOnSlide(current, {
      kind: "slide_styles",
      new_content: ".slide{color:red}",
      new_slide_payload: null,
    });
    expect(out?.slide_styles).toBe(".slide{color:red}");
    expect(out?.html_body).toBe(current.html_body);
  });

  it("slide_title replaces only the title", () => {
    const out = previewProposalOnSlide(current, {
      kind: "slide_title",
      new_content: "Intro",
      new_slide_payload: null,
    });
    expect(out?.title).toBe("Intro");
    expect(out?.html_body).toBe(current.html_body);
  });

  it("slide_edit merges only the fields PRESENT in the payload (absent fields kept)", () => {
    const out = previewProposalOnSlide(current, {
      kind: "slide_edit",
      new_content: null,
      new_slide_payload: { html_body: "<section class=\"slide\">B</section>" },
    });
    // html_body overridden, slide_styles + title untouched.
    expect(out).toEqual({
      title: "Cover",
      html_body: "<section class=\"slide\">B</section>",
      slide_styles: ".slide{color:black}",
    });
  });

  it("slide_edit honors an explicit empty-string clear (present, so it overrides)", () => {
    const out = previewProposalOnSlide(current, {
      kind: "slide_edit",
      new_content: null,
      new_slide_payload: { slide_styles: "" },
    });
    expect(out?.slide_styles).toBe("");
  });

  it("returns null for a slide_edit whose payload changes nothing renderable", () => {
    expect(
      previewProposalOnSlide(current, {
        kind: "slide_edit",
        new_content: null,
        new_slide_payload: {},
      }),
    ).toBeNull();
    expect(
      previewProposalOnSlide(current, {
        kind: "slide_edit",
        new_content: null,
        new_slide_payload: null,
      }),
    ).toBeNull();
  });

  it("returns null for single-field kinds missing their value (never sets a column to null)", () => {
    expect(
      previewProposalOnSlide(current, { kind: "slide_html", new_content: null, new_slide_payload: null }),
    ).toBeNull();
  });

  it("returns null for theme/nav/structural/deck-title kinds (nothing to preview as one slide)", () => {
    for (const kind of ["theme_css", "nav_js", "slide_create", "slide_reorder", "slide_delete", "deck_title"]) {
      expect(
        previewProposalOnSlide(current, { kind, new_content: "x", new_slide_payload: { html_body: "x" } }),
        kind,
      ).toBeNull();
    }
  });

  it("does not mutate the input", () => {
    const frozen = Object.freeze({ ...current });
    previewProposalOnSlide(frozen, {
      kind: "slide_html",
      new_content: "<section>new</section>",
      new_slide_payload: null,
    });
    expect(frozen.html_body).toBe(current.html_body);
  });
});
