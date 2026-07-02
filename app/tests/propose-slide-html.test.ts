import { describe, expect, it } from "vitest";
import {
  buildProposeSlideEditRow,
  ensureSlideSectionWrap,
} from "../src/lib/canvas/propose-slide-html";

// buildProposeSlideEditRow shapes a member's hand edit into the canvas_deck_edit
// insert row proposeSlideHtmlEdit sends. It must mirror the MCP propose_slide_edit
// tool's row and satisfy the canvas_deck_edit_content_shape_chk CHECK constraint
// (migration 0032): kind='slide_edit', new_content=null, new_slide_payload with at
// least one string field (html_body here), proposed_by_kind='user'.

const SLIDE = "slide-1";
const BASE = "ver-7";

describe("ensureSlideSectionWrap", () => {
  it("wraps bare markup in a single <section class=\"slide\">", () => {
    expect(ensureSlideSectionWrap("<h1>Hi</h1>")).toBe(
      '<section class="slide"><h1>Hi</h1></section>',
    );
  });

  it("leaves an existing <section> wrapper untouched (custom classes survive)", () => {
    const already = '<section class="slide cover"><h1>Hi</h1></section>';
    expect(ensureSlideSectionWrap(already)).toBe(already);
  });

  it("tolerates leading whitespace before the <section>", () => {
    const s = '\n  <section class="slide">x</section>';
    expect(ensureSlideSectionWrap(s)).toBe(s);
  });
});

describe("buildProposeSlideEditRow", () => {
  it("shapes a slide_edit row mirroring the MCP tool", () => {
    const r = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide"><h1>New</h1></section>',
      rationale: "fix the headline",
      baseVersionId: BASE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toEqual({
      slide_id: SLIDE,
      kind: "slide_edit",
      proposed_by_kind: "user",
      new_content: null,
      new_slide_payload: {
        html_body: '<section class="slide"><h1>New</h1></section>',
      },
      rationale: "fix the headline",
      status: "pending",
      base_version_id: BASE,
    });
  });

  it("section-wraps bare html_body in the payload", () => {
    const r = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: "<h1>bare</h1>",
      baseVersionId: BASE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.new_slide_payload.html_body).toBe(
      '<section class="slide"><h1>bare</h1></section>',
    );
  });

  it("carries slide_styles only when supplied", () => {
    const withStyles = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide">x</section>',
      slideStyles: ".a{color:red}",
      baseVersionId: BASE,
    });
    expect(withStyles.ok).toBe(true);
    if (!withStyles.ok) return;
    expect(withStyles.row.new_slide_payload.slide_styles).toBe(".a{color:red}");

    const without = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide">x</section>',
      baseVersionId: BASE,
    });
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect("slide_styles" in without.row.new_slide_payload).toBe(false);
  });

  it("trims a supplied title and keeps an explicit empty string", () => {
    const r = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide">x</section>',
      title: "  Hello  ",
      baseVersionId: BASE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.new_slide_payload.title).toBe("Hello");

    const cleared = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide">x</section>',
      title: "",
      baseVersionId: BASE,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.row.new_slide_payload.title).toBe("");
  });

  it("normalizes a blank rationale to null", () => {
    const r = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide">x</section>',
      rationale: "   ",
      baseVersionId: BASE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.rationale).toBeNull();
  });

  it("passes a null base_version_id through (slide with no version yet)", () => {
    const r = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: '<section class="slide">x</section>',
      baseVersionId: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.base_version_id).toBeNull();
  });

  it("rejects empty html (mirrors saveSlideHtmlDirect's empty_html guard)", () => {
    const r = buildProposeSlideEditRow({
      slideId: SLIDE,
      htmlBody: "   ",
      baseVersionId: BASE,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/can't be empty/i);
  });
});
