// Single source of truth for the proposal review affordances
// (Approve / Reject / Withdraw). Three surfaces compute these — the review
// sheet (proposal-queries.ts), the standalone proposal page, and the editor's
// inline chip (deck-workspace.tsx) — and they used to hand-roll the rule
// independently, which is how they drifted. They all call this now.
//
// These are UI affordance hints ONLY. canvas_apply_edit / canvas_reject_edit
// re-enforce every rule server-side (deck-edit authority + the self-approval
// guard), so a stale or over-permissive hint can at worst surface a button
// that returns an error — never a privilege escalation.
//
// Client-safe: no Node-only imports, so the client editor can import it.

export type ProposalPermissionInput = {
  // The proposal is actionable only while pending.
  isPending: boolean;
  // Current user authored the proposal.
  isProposer: boolean;
  // Current user is an admin/owner of the proposal's workspace.
  isWorkspaceAdmin: boolean;
  // Current user passes canvas_can_edit_deck for the proposal's deck — the
  // authority canvas_apply_edit (0039, SECURITY DEFINER) checks explicitly.
  // Approval used to additionally hinge on per-row slide owner/creator RLS,
  // which made identical proposals approvable by one editor and not another;
  // 0039 retired that, so deck-edit authority is the whole rule.
  canEditDeck: boolean;
  // The proposal's workspace has opted into member self-approval
  // (workspaces.canvas_allow_self_approval). Off by default.
  allowSelfApproval: boolean;
};

export type ProposalPermissions = {
  canApprove: boolean;
  canReject: boolean;
  canWithdraw: boolean;
  // The current user may revise the pending proposal's content/rationale in
  // place. See canEdit derivation below.
  canEdit: boolean;
};

// Approve/Reject move together (a reviewer who can apply can also reject).
// Withdraw is the proposer's own escape hatch and is independent of the
// approval rule.
//
// Approval rule:
//   - Admins/owners can always approve.
//   - A non-proposer with deck-edit authority can approve a peer's proposal.
//   - The proposer can self-approve ONLY when the workspace opted in AND they
//     have deck-edit authority. With allowSelfApproval=false this collapses
//     to exactly the legacy "needs a different reviewer" behavior.
//
// Edit rule:
//   canEdit = pending && (isProposer || canApprove)
//   The proposer can always refine their own pending proposal (like withdraw),
//   and any approver can edit it too. This is exactly the predicate
//   canvas_update_edit re-checks server-side (proposer OR canvas_can_edit_deck);
//   the self-approval flag is irrelevant to editing, which is why we OR
//   isProposer in directly rather than routing the author through canApprove.
export function computeProposalPermissions(
  input: ProposalPermissionInput,
): ProposalPermissions {
  const {
    isPending,
    isProposer,
    isWorkspaceAdmin,
    canEditDeck,
    allowSelfApproval,
  } = input;

  const canApprove =
    isPending &&
    (isWorkspaceAdmin || (canEditDeck && (!isProposer || allowSelfApproval)));

  return {
    canApprove,
    canReject: canApprove,
    canWithdraw: isPending && isProposer,
    canEdit: isPending && (isProposer || canApprove),
  };
}
