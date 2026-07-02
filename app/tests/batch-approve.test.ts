// Tests for the shared bulk-approve eligibility rule (lib/canvas/batch-approve).
//
// Bug class it guards: the inbox's old "Approve all" had NONE of the editor's
// claudeBatch guards — it would happily stack two pending edits on one slide
// (the later silently overwriting the earlier) and approve stale proposals
// over newer content. Editor and inbox now share this one rule, and
// approveAllProposals re-verifies it server-side, so these cases lock in the
// exact semantics both surfaces rely on.

import { describe, expect, it } from "vitest";
import {
  eligibleForBatch,
  isStaleForBatch,
  type BatchProposal,
} from "../src/lib/canvas/batch-approve";

let n = 0;
function p(over: Partial<BatchProposal>): BatchProposal {
  n += 1;
  return {
    id: `edit-${n}`,
    slide_id: null,
    kind: "slide_edit",
    proposed_by_kind: "claude",
    base_version_id: null,
    ...over,
  };
}

const noVersions = new Map<string, string | null>();

describe("eligibleForBatch", () => {
  it("keeps a lone, fresh, Claude-authored slide proposal", () => {
    const row = p({ slide_id: "s1" });
    expect(eligibleForBatch([row], noVersions)).toEqual([row]);
  });

  it("excludes human-authored proposals", () => {
    const row = p({ slide_id: "s1", proposed_by_kind: "user" });
    expect(eligibleForBatch([row], noVersions)).toEqual([]);
  });

  it("excludes EVERY proposal on a target with more than one pending", () => {
    const a = p({ slide_id: "s1" });
    const b = p({ slide_id: "s1" });
    const lone = p({ slide_id: "s2" });
    expect(eligibleForBatch([a, b, lone], noVersions)).toEqual([lone]);
  });

  it("counts non-Claude pendings against the target too", () => {
    // A human's pending edit on the same slide means approving Claude's
    // would invalidate (or be clobbered by) the other — leave both for
    // manual review.
    const claude = p({ slide_id: "s1" });
    const human = p({ slide_id: "s1", proposed_by_kind: "user" });
    expect(eligibleForBatch([claude, human], noVersions)).toEqual([]);
  });

  it("excludes a stale slide proposal (slide moved past its base version)", () => {
    const stale = p({
      slide_id: "s1",
      kind: "slide_html",
      base_version_id: "v1",
    });
    const versions = new Map([["s1", "v2"]]);
    expect(eligibleForBatch([stale], versions)).toEqual([]);
  });

  it("keeps a slide proposal whose base version still matches", () => {
    const fresh = p({
      slide_id: "s1",
      kind: "slide_html",
      base_version_id: "v2",
    });
    const versions = new Map([["s1", "v2"]]);
    expect(eligibleForBatch([fresh], versions)).toEqual([fresh]);
  });

  it("excludes a stale slide_edit — the kind propose_slide_edit/patch emit", () => {
    // Regression: STALE_CHECKED_KINDS once listed only the legacy
    // slide_html/slide_styles/slide_title, so the bundled slide_edit that the
    // two most-used Claude tools actually write was treated as never-stale and
    // slipped through "Approve N from Claude", silently clobbering newer content.
    const stale = p({ slide_id: "s1", kind: "slide_edit", base_version_id: "v1" });
    const versions = new Map([["s1", "v2"]]);
    expect(eligibleForBatch([stale], versions)).toEqual([]);
  });

  it("scopes deck-level targets by deck_id so two decks' theme edits don't collide", () => {
    const a = p({ kind: "theme_css", deck_id: "deck-a" });
    const b = p({ kind: "theme_css", deck_id: "deck-b" });
    expect(eligibleForBatch([a, b], noVersions)).toEqual([a, b]);
  });

  it("treats two deck-level edits of one kind on ONE deck as a contested target", () => {
    const a = p({ kind: "theme_css", deck_id: "deck-a" });
    const b = p({ kind: "theme_css", deck_id: "deck-a" });
    expect(eligibleForBatch([a, b], noVersions)).toEqual([]);
  });

  it("applies the caller's canApprove veto", () => {
    const allowed = p({ slide_id: "s1" });
    const denied = p({ slide_id: "s2" });
    const out = eligibleForBatch(
      [allowed, denied],
      noVersions,
      (row) => row.id === allowed.id,
    );
    expect(out).toEqual([allowed]);
  });
});

describe("isStaleForBatch", () => {
  it("only judges the slide-content kinds that carry a base version", () => {
    const versions = new Map([["s1", "v9"]]);
    // slide_delete carries no comparable base — counts as fresh here.
    expect(
      isStaleForBatch(
        p({ slide_id: "s1", kind: "slide_delete", base_version_id: "v1" }),
        versions,
      ),
    ).toBe(false);
    expect(
      isStaleForBatch(
        p({ slide_id: "s1", kind: "slide_styles", base_version_id: "v1" }),
        versions,
      ),
    ).toBe(true);
  });

  it("judges slide_edit, not only the legacy single-field kinds", () => {
    // The two most-used Claude editing tools (propose_slide_edit /
    // propose_slide_patch) emit kind "slide_edit" with a stamped
    // base_version_id. It must be staleness-checked like the legacy kinds.
    const versions = new Map([["s1", "v2"]]);
    expect(
      isStaleForBatch(
        p({ slide_id: "s1", kind: "slide_edit", base_version_id: "v1" }),
        versions,
      ),
    ).toBe(true);
    expect(
      isStaleForBatch(
        p({ slide_id: "s1", kind: "slide_edit", base_version_id: "v2" }),
        versions,
      ),
    ).toBe(false);
  });

  it("treats an unknown slide or missing base version as fresh", () => {
    expect(
      isStaleForBatch(
        p({ slide_id: "s-unknown", kind: "slide_html", base_version_id: "v1" }),
        noVersions,
      ),
    ).toBe(false);
    expect(
      isStaleForBatch(
        p({ slide_id: "s1", kind: "slide_html", base_version_id: null }),
        new Map([["s1", "v2"]]),
      ),
    ).toBe(false);
  });
});
