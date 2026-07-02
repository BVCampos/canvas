import { describe, expect, it } from "vitest";
import {
  buildProposalEditPatch,
  isBuildError,
  type ProposalEditFormState,
} from "../src/lib/canvas/proposal-edit";

// buildProposalEditPatch shapes the in-place edit form's field state into the
// payload updateProposal sends. It must stay in lockstep with
// canvas_update_edit's per-kind validation + the content-shape CHECK
// constraint: text kinds carry new_content, slide_edit/slide_create/
// slide_reorder carry new_slide_payload, slide_delete carries neither.

const REV = 3;

// A field state with every field populated; each test overrides what it needs.
const full = (over: Partial<ProposalEditFormState> = {}): ProposalEditFormState => ({
  content: "hello",
  rationale: "because",
  editKeys: { html_body: true, slide_styles: true, title: true },
  slideEdit: { html_body: "<section class=\"slide\">x</section>", slide_styles: ".a{}", title: "T" },
  slideCreate: { position: 2, title: "New", html_body: "<section class=\"slide\">n</section>", slide_styles: "" },
  reorderPayload: { order: ["a", "b", "c"] },
  ...over,
});

describe("buildProposalEditPatch", () => {
  describe("text-content kinds", () => {
    for (const kind of ["slide_html", "slide_styles", "theme_css", "nav_js"] as const) {
      it(`${kind}: carries new_content, no payload`, () => {
        const r = buildProposalEditPatch(kind, REV, full({ content: "body" }));
        expect(isBuildError(r)).toBe(false);
        if (isBuildError(r)) return;
        expect(r.new_content).toBe("body");
        expect(r.new_slide_payload).toBeUndefined();
        expect(r.expected_revision).toBe(REV);
      });
    }

    // Empty content is only forbidden where the server forbids it: deck_title
    // (canvas_apply_edit) and slide_html (a slide needs markup). CSS / nav JS /
    // slide label may be emptied, so the form must not block those.
    it("slide_html: empty content is rejected (a slide needs markup)", () => {
      expect(isBuildError(buildProposalEditPatch("slide_html", REV, full({ content: "  " })))).toBe(true);
    });

    for (const kind of ["slide_styles", "theme_css", "nav_js"] as const) {
      it(`${kind}: empty content is allowed (clearing styles/nav is valid)`, () => {
        const r = buildProposalEditPatch(kind, REV, full({ content: "" }));
        expect(isBuildError(r)).toBe(false);
        if (isBuildError(r)) return;
        expect(r.new_content).toBe("");
      });
    }

    it("slide_title carries the label as new_content", () => {
      const r = buildProposalEditPatch("slide_title", REV, full({ content: "Label" }));
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_content).toBe("Label");
    });

    it("slide_title: an empty label is allowed (clears the sidebar label)", () => {
      const r = buildProposalEditPatch("slide_title", REV, full({ content: "" }));
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_content).toBe("");
    });

    it("deck_title rejects a whitespace-only title", () => {
      expect(isBuildError(buildProposalEditPatch("deck_title", REV, full({ content: "   " })))).toBe(true);
    });

    it("deck_title accepts a non-empty title", () => {
      const r = buildProposalEditPatch("deck_title", REV, full({ content: "Q3 Deck" }));
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_content).toBe("Q3 Deck");
    });
  });

  describe("slide_edit", () => {
    it("includes only the touched fields", () => {
      const r = buildProposalEditPatch(
        "slide_edit",
        REV,
        full({ editKeys: { html_body: true, slide_styles: false, title: false } }),
      );
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_slide_payload).toEqual({ html_body: "<section class=\"slide\">x</section>" });
      expect(r.new_content).toBeUndefined();
    });

    it("includes all three when all are touched", () => {
      const r = buildProposalEditPatch("slide_edit", REV, full());
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(Object.keys(r.new_slide_payload ?? {}).sort()).toEqual([
        "html_body",
        "slide_styles",
        "title",
      ]);
    });

    it("errors when no field is touched", () => {
      const r = buildProposalEditPatch(
        "slide_edit",
        REV,
        full({ editKeys: { html_body: false, slide_styles: false, title: false } }),
      );
      expect(isBuildError(r)).toBe(true);
    });

    it("keeps an emptied touched field (clearing CSS is a real edit)", () => {
      const r = buildProposalEditPatch(
        "slide_edit",
        REV,
        full({
          editKeys: { html_body: false, slide_styles: true, title: false },
          slideEdit: { html_body: "", slide_styles: "", title: "" },
        }),
      );
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_slide_payload).toEqual({ slide_styles: "" });
    });
  });

  describe("slide_create", () => {
    it("builds the full payload", () => {
      const r = buildProposalEditPatch("slide_create", REV, full());
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_slide_payload).toEqual({
        position: 2,
        title: "New",
        html_body: "<section class=\"slide\">n</section>",
        slide_styles: "",
      });
    });

    it("rejects empty html", () => {
      const r = buildProposalEditPatch(
        "slide_create",
        REV,
        full({ slideCreate: { position: 0, title: "", html_body: "   ", slide_styles: "" } }),
      );
      expect(isBuildError(r)).toBe(true);
    });

    it("rejects a negative or non-integer position", () => {
      expect(
        isBuildError(
          buildProposalEditPatch(
            "slide_create",
            REV,
            full({ slideCreate: { position: -1, title: "", html_body: "<x/>", slide_styles: "" } }),
          ),
        ),
      ).toBe(true);
      expect(
        isBuildError(
          buildProposalEditPatch(
            "slide_create",
            REV,
            full({ slideCreate: { position: 1.5, title: "", html_body: "<x/>", slide_styles: "" } }),
          ),
        ),
      ).toBe(true);
    });
  });

  describe("structural kinds (rationale-only in this surface)", () => {
    it("slide_reorder resends the unchanged order payload", () => {
      const r = buildProposalEditPatch("slide_reorder", REV, full());
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_slide_payload).toEqual({ order: ["a", "b", "c"] });
      expect(r.new_content).toBeUndefined();
    });

    it("slide_delete carries neither content nor payload", () => {
      const r = buildProposalEditPatch("slide_delete", REV, full());
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.new_content).toBeUndefined();
      expect(r.new_slide_payload).toBeUndefined();
      expect(r.expected_revision).toBe(REV);
    });
  });

  describe("rationale handling (every kind)", () => {
    it("trims a whitespace-only rationale to null", () => {
      const r = buildProposalEditPatch("slide_html", REV, full({ rationale: "   " }));
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.rationale).toBeNull();
    });

    it("keeps a non-empty rationale verbatim", () => {
      const r = buildProposalEditPatch("slide_html", REV, full({ rationale: "tighten copy" }));
      expect(isBuildError(r)).toBe(false);
      if (isBuildError(r)) return;
      expect(r.rationale).toBe("tighten copy");
    });
  });
});
