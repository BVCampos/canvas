// Should approving THIS proposal count toward the inline "trust verified agent
// patches on this deck?" offer (speed discovery 2026-07 #1)?
//
// The trusted fast lane is built and safe, but 0 decks ever opted in — the
// toggle is buried in the deck ⋯ menu. Rather than move it, we surface the
// offer where the pain is: after the Nth time a deck owner hand-approves a
// render-verified agent patch they could have let apply itself. This predicate
// decides which approvals count; the workspace tallies them per deck and, at
// the threshold, shows a one-click offer that flips the existing deck flag.
//
// An approval counts only when enabling the lane would ACTUALLY have helped:
// the proposal is a deterministic, render-verified, agent-authored patch, and
// the approver could enable + benefit from the lane (owns/created the deck,
// workspace self-approval is on, the deck isn't already opted in). The
// conditions mirror canvas_apply_trusted_agent_edit's deck/workspace-level
// gates; its proposer-side gates (full membership, slide ownership) are
// deliberately NOT mirrored — they need per-proposal proposer data the tally
// doesn't carry, and the RPC re-checks everything at apply anyway. In the rare
// cross-owner case (a deck creator approving another member's patch on a slide
// that member doesn't own) an approval may count that the lane would refuse
// for that one slide; the offer is still sound, since enabling helps every
// slide the lane CAN serve.

export type FastLaneCandidate = {
  proposed_by_kind: string;
  auto_apply_eligible: boolean;
  agent_rendered_at: string | null;
};

export type FastLaneContext = {
  deckFastLaneEnabled: boolean;
  canManageFastLane: boolean;
  workspaceSelfApproval: boolean;
};

export function approvalCountsTowardFastLaneOffer(
  proposal: FastLaneCandidate,
  ctx: FastLaneContext,
): boolean {
  // Already on, or the approver couldn't turn it on / it wouldn't fire — no
  // point nudging.
  if (ctx.deckFastLaneEnabled) return false;
  if (!ctx.canManageFastLane) return false;
  if (!ctx.workspaceSelfApproval) return false;
  // The proposal itself must be exactly what the lane would auto-apply.
  return (
    proposal.proposed_by_kind === "claude" &&
    proposal.auto_apply_eligible &&
    proposal.agent_rendered_at != null
  );
}

// The number of qualifying self-approvals before the offer appears (the doc's
// suggested "You've approved 5 verified agent patches on this deck").
export const FAST_LANE_OFFER_THRESHOLD = 5;
