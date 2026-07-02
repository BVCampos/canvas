import { describe, it, expect } from "vitest";
import {
  approvalCountsTowardFastLaneOffer,
  FAST_LANE_OFFER_THRESHOLD,
  type FastLaneCandidate,
  type FastLaneContext,
} from "../src/lib/canvas/fast-lane-offer";

const eligiblePatch: FastLaneCandidate = {
  proposed_by_kind: "claude",
  auto_apply_eligible: true,
  agent_rendered_at: "2026-07-02T00:00:00Z",
};

const okCtx: FastLaneContext = {
  deckFastLaneEnabled: false,
  canManageFastLane: true,
  workspaceSelfApproval: true,
};

describe("approvalCountsTowardFastLaneOffer", () => {
  it("counts a render-verified, deterministic, agent-authored patch when the owner could opt in", () => {
    expect(approvalCountsTowardFastLaneOffer(eligiblePatch, okCtx)).toBe(true);
  });

  it("does NOT count when the deck already has the fast lane on", () => {
    expect(
      approvalCountsTowardFastLaneOffer(eligiblePatch, {
        ...okCtx,
        deckFastLaneEnabled: true,
      }),
    ).toBe(false);
  });

  it("does NOT count when the approver can't manage the fast lane (not owner/admin)", () => {
    expect(
      approvalCountsTowardFastLaneOffer(eligiblePatch, {
        ...okCtx,
        canManageFastLane: false,
      }),
    ).toBe(false);
  });

  it("does NOT count when workspace self-approval is off (the lane can't fire)", () => {
    expect(
      approvalCountsTowardFastLaneOffer(eligiblePatch, {
        ...okCtx,
        workspaceSelfApproval: false,
      }),
    ).toBe(false);
  });

  it("does NOT count a human-authored proposal", () => {
    expect(
      approvalCountsTowardFastLaneOffer(
        { ...eligiblePatch, proposed_by_kind: "user" },
        okCtx,
      ),
    ).toBe(false);
  });

  it("does NOT count a full-rewrite (not auto_apply_eligible)", () => {
    expect(
      approvalCountsTowardFastLaneOffer(
        { ...eligiblePatch, auto_apply_eligible: false },
        okCtx,
      ),
    ).toBe(false);
  });

  it("does NOT count a patch the agent never render-verified", () => {
    expect(
      approvalCountsTowardFastLaneOffer(
        { ...eligiblePatch, agent_rendered_at: null },
        okCtx,
      ),
    ).toBe(false);
  });

  it("exposes a sane threshold", () => {
    expect(FAST_LANE_OFFER_THRESHOLD).toBeGreaterThanOrEqual(3);
  });
});
