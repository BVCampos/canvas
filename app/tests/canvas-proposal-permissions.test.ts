import { describe, expect, it } from "vitest";
import {
  computeProposalPermissions,
  type ProposalPermissionInput,
} from "../src/lib/canvas/proposal-permissions";

// Base = a pending slide proposal authored by a plain member with deck-edit
// authority (canvas_can_edit_deck — the 0039 approval authority), in a
// workspace that has NOT opted into self-approval. Each test overrides only
// what it's exercising.
const base: ProposalPermissionInput = {
  isPending: true,
  isProposer: true,
  isWorkspaceAdmin: false,
  canEditDeck: true,
  allowSelfApproval: false,
};

describe("computeProposalPermissions", () => {
  describe("withdraw", () => {
    it("a proposer can always withdraw a pending proposal", () => {
      expect(computeProposalPermissions(base).canWithdraw).toBe(true);
    });

    it("a non-proposer never sees withdraw", () => {
      expect(
        computeProposalPermissions({ ...base, isProposer: false }).canWithdraw,
      ).toBe(false);
    });

    it("withdraw is gone once the proposal is resolved", () => {
      expect(
        computeProposalPermissions({ ...base, isPending: false }).canWithdraw,
      ).toBe(false);
    });
  });

  describe("self-approval guard OFF (default)", () => {
    it("a member CANNOT approve/reject their own proposal", () => {
      const p = computeProposalPermissions(base);
      expect(p.canApprove).toBe(false);
      expect(p.canReject).toBe(false);
    });

    it("a member CAN approve a peer's proposal they have authority over", () => {
      const p = computeProposalPermissions({ ...base, isProposer: false });
      expect(p.canApprove).toBe(true);
      expect(p.canReject).toBe(true);
    });

    it("a member CANNOT approve a peer's proposal they lack authority over", () => {
      const p = computeProposalPermissions({
        ...base,
        isProposer: false,
        canEditDeck: false,
      });
      expect(p.canApprove).toBe(false);
    });

    it("an admin CAN self-approve even without target authority", () => {
      const p = computeProposalPermissions({
        ...base,
        isWorkspaceAdmin: true,
        canEditDeck: false,
      });
      expect(p.canApprove).toBe(true);
      expect(p.canReject).toBe(true);
    });
  });

  describe("self-approval guard ON (workspace opted in)", () => {
    it("a member CAN self-approve a proposal they have authority over", () => {
      const p = computeProposalPermissions({
        ...base,
        allowSelfApproval: true,
      });
      expect(p.canApprove).toBe(true);
      expect(p.canReject).toBe(true);
    });

    it("a member still CANNOT self-approve a target they lack authority over", () => {
      // The RLS net: the flag lifts the self-approval guard, not the
      // underlying write permission.
      const p = computeProposalPermissions({
        ...base,
        allowSelfApproval: true,
        canEditDeck: false,
      });
      expect(p.canApprove).toBe(false);
    });

    it("never grants approval on an already-resolved proposal", () => {
      const p = computeProposalPermissions({
        ...base,
        allowSelfApproval: true,
        isPending: false,
      });
      expect(p.canApprove).toBe(false);
      expect(p.canReject).toBe(false);
    });

    it("a peer with authority can still approve (unchanged)", () => {
      const p = computeProposalPermissions({
        ...base,
        allowSelfApproval: true,
        isProposer: false,
      });
      expect(p.canApprove).toBe(true);
    });
  });

  describe("edit (proposer + approvers)", () => {
    // canEdit mirrors exactly what canvas_update_edit re-checks server-side:
    // proposer OR admin OR target write authority, while pending.
    it("the proposer can always edit their own pending proposal", () => {
      // Even with self-approval OFF (so they can't approve it), they can edit.
      expect(computeProposalPermissions(base).canEdit).toBe(true);
    });

    it("a peer with target authority can edit (an approver)", () => {
      expect(
        computeProposalPermissions({ ...base, isProposer: false }).canEdit,
      ).toBe(true);
    });

    it("an admin can edit even without target authority", () => {
      expect(
        computeProposalPermissions({
          ...base,
          isProposer: false,
          isWorkspaceAdmin: true,
          canEditDeck: false,
        }).canEdit,
      ).toBe(true);
    });

    it("a non-proposer with no authority and no admin role cannot edit", () => {
      expect(
        computeProposalPermissions({
          ...base,
          isProposer: false,
          canEditDeck: false,
        }).canEdit,
      ).toBe(false);
    });

    it("editing is gone once the proposal is resolved", () => {
      expect(
        computeProposalPermissions({ ...base, isPending: false }).canEdit,
      ).toBe(false);
    });

    it("the self-approval flag does not affect editing", () => {
      const off = computeProposalPermissions({ ...base, allowSelfApproval: false });
      const on = computeProposalPermissions({ ...base, allowSelfApproval: true });
      expect(off.canEdit).toBe(true);
      expect(on.canEdit).toBe(true);
    });
  });

  describe("flag-off parity with the legacy rule", () => {
    // Exhaustive truth-table check that allowSelfApproval=false reproduces the
    // exact pre-existing behavior: pending && (admin || (!isProposer && authority)).
    const bools = [true, false];
    for (const isPending of bools) {
      for (const isProposer of bools) {
        for (const isWorkspaceAdmin of bools) {
          for (const canEditDeck of bools) {
            it(`pending=${isPending} proposer=${isProposer} admin=${isWorkspaceAdmin} authority=${canEditDeck}`, () => {
              const legacy =
                isPending &&
                (isWorkspaceAdmin ||
                  (!isProposer && canEditDeck));
              const p = computeProposalPermissions({
                isPending,
                isProposer,
                isWorkspaceAdmin,
                canEditDeck,
                allowSelfApproval: false,
              });
              expect(p.canApprove).toBe(legacy);
              expect(p.canReject).toBe(legacy);
              expect(p.canWithdraw).toBe(isPending && isProposer);
              // Edit = pending && (proposer || approver). With the flag off,
              // "approver" collapses to the legacy approve rule.
              expect(p.canEdit).toBe(isPending && (isProposer || legacy));
            });
          }
        }
      }
    }
  });
});
