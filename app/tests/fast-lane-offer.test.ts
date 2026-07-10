/**
 * The fail-closed assertions below rely on the node env having NO window at
 * all — pin it so they self-defend if the suite ever migrates to jsdom.
 * @vitest-environment node
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  approvalCountsTowardFastLaneOffer,
  FAST_LANE_OFFER_THRESHOLD,
  markFastLaneOfferDismissed,
  readFastLaneOfferDismissed,
  reconcileFastLaneOfferDismissal,
  subscribeFastLaneOfferDismissal,
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

// Dismissal store — the localStorage-backed useSyncExternalStore shape shared
// with rail-prefs. Bug classes it guards: (1) a never-dismissed deck must read
// false after the post-hydration reconcile (the server snapshot says
// "dismissed"; without a notify the banner never shows at all); (2) blocked
// storage fails closed — never-nag beats re-nag; (3) same-tab writes and the
// reconcile both fire the subscriber notify, or consumers never re-render;
// (4) asymmetric storage (getItem works, setItem throws — quota) keeps a
// dismissal for the session via the in-memory overlay.
//
// NOTE: the module-level overlay Set persists across tests in this file, so
// every test uses its own deck id — an id marked in one test reads dismissed
// forever after, regardless of the storage stub.
describe("fast-lane offer dismissal store", () => {
  function stubLocalStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads not-dismissed by default and round-trips a dismissal per deck", () => {
    const store = stubLocalStorage();
    expect(readFastLaneOfferDismissed("deck-a")).toBe(false);
    markFastLaneOfferDismissed("deck-a");
    expect(readFastLaneOfferDismissed("deck-a")).toBe(true);
    expect(readFastLaneOfferDismissed("deck-b")).toBe(false);
    // Pin the documented key so the flag stays legible in a hand-inspected
    // localStorage (mirrors rail-prefs' documented-values test) — and so the
    // round-trip provably went through STORAGE, not just the memory overlay.
    expect(store.get("canvas:floffered:deck-a")).toBe("1");
  });

  it("fails closed (dismissed) when storage is unavailable or throws", () => {
    // A never-marked deck id: the in-memory overlay must not be what makes
    // these reads true — only the blocked-storage fallback.
    // No window stub at all — the node test env has none.
    expect(readFastLaneOfferDismissed("deck-blocked")).toBe(true);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(readFastLaneOfferDismissed("deck-blocked")).toBe(true);
    expect(() => markFastLaneOfferDismissed("deck-blocked")).not.toThrow();
  });

  it("keeps a dismissal for the session when writes throw but reads work (quota)", () => {
    // Asymmetric failure: getItem works, setItem throws (QuotaExceededError
    // on a full origin). The read side can't fail closed — storage answers
    // "not dismissed" — so without the overlay the banner the user just
    // actioned would re-appear on the very next notify.
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(readFastLaneOfferDismissed("deck-quota")).toBe(false);
    expect(() => markFastLaneOfferDismissed("deck-quota")).not.toThrow();
    // Nothing persisted — the overlay, not storage, holds the dismissal.
    expect(store.size).toBe(0);
    expect(readFastLaneOfferDismissed("deck-quota")).toBe(true);
  });

  it("notifies on dismissal and reconcile, and stops after unsubscribe", () => {
    stubLocalStorage();
    const cb = vi.fn();
    const unsubscribe = subscribeFastLaneOfferDismissal(cb);
    try {
      markFastLaneOfferDismissed("deck-notify");
      expect(cb).toHaveBeenCalledTimes(1);
      reconcileFastLaneOfferDismissal();
      expect(cb).toHaveBeenCalledTimes(2);
    } finally {
      // Always drop the listener — a leaked subscription would leach notify
      // counts into later tests if an assertion above ever fails.
      unsubscribe();
    }
    reconcileFastLaneOfferDismissal();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
