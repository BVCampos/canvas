// Should approving THIS proposal count toward the inline "trust verified agent
// patches on this deck?" offer (speed discovery 2026-07 #1)?
//
// The trusted fast lane is built and safe, but 0 decks ever opted in — the
// toggle is buried in the deck ⋯ menu. Rather than move it, we surface the
// offer where the pain is: after the Nth time a deck owner hand-approves a
// render-verified agent patch they could have let apply itself.
//
// The count is DB-derived: the deck page counts the viewer's historical
// qualifying self-approvals on the deck, so every approve surface counts —
// single chip, multi-select, the inbox — and the tally survives browsers and
// reloads. (The first cut incremented localStorage from the single-chip path
// only; four days of prod showed batch approvals — exactly the high-volume
// sessions the lane serves — never counted, and per-browser counters split.)
// This predicate remains for LIVE increments during a session, matching the
// qualifying shape the DB query selects; at the threshold the workspace shows
// a one-click offer that flips the existing deck flag.
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

// The number of qualifying self-approvals before the offer appears. 3, not
// the original 5: prod base rates (2026-07) put the most active deck at 3
// qualifying approvals in four days, and the decks the lane helps most (the
// weeklies) live about a week — a threshold of 5 would rarely fire before the
// deck is retired.
export const FAST_LANE_OFFER_THRESHOLD = 3;

// --- Dismissal store -------------------------------------------------------
// The per-deck "already offered" flag lives in localStorage (per browser, by
// design: one banner per machine, never re-nagged once actioned). Components
// read it via useSyncExternalStore — the theme-toggle pattern; mirroring
// localStorage into useState would trip react-hooks/set-state-in-effect.
// localStorage fires no events for same-tab writes, so the writer notifies
// subscribers itself.

const dismissListeners = new Set<() => void>();

export function subscribeFastLaneOfferDismissal(cb: () => void): () => void {
  dismissListeners.add(cb);
  return () => {
    dismissListeners.delete(cb);
  };
}

// In-memory overlay for dismissals made this session. localStorage can fail
// asymmetrically — reads work but writes throw (QuotaExceededError on a full
// origin) — and then a swallowed write would leave the key null, the notify
// would re-read "not dismissed", and the banner the user just actioned would
// stay up and re-nag every visit: the inverse of never-nag. The overlay makes
// the click take effect immediately regardless of persistence.
const memoryDismissed = new Set<string>();

// True on the server pass and when storage is blocked (private mode): without
// a working dismissal flag the offer would re-nag every visit, so it never
// shows at all.
export function readFastLaneOfferDismissed(deckId: string): boolean {
  if (memoryDismissed.has(deckId)) return true;
  try {
    return window.localStorage.getItem(`canvas:floffered:${deckId}`) != null;
  } catch {
    return true;
  }
}

export function markFastLaneOfferDismissed(deckId: string): void {
  memoryDismissed.add(deckId);
  try {
    window.localStorage.setItem(`canvas:floffered:${deckId}`, "1");
  } catch {
    /* persistence failed — the memory overlay above keeps the dismissal for
       this session; fully blocked storage still fails closed on read */
  }
  reconcileFastLaneOfferDismissal();
}

// Re-notify every subscriber so useSyncExternalStore re-reads the client
// snapshot. Needed once after mount (same React behavior rail-prefs works
// around): the server snapshot says "dismissed", and without this notify a
// never-dismissed flag stays true forever — the only other notifiers are the
// banner's own buttons, which never render.
export function reconcileFastLaneOfferDismissal(): void {
  for (const cb of dismissListeners) cb();
}
