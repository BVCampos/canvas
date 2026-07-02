// Shared bulk-approve eligibility — ONE safety semantic for every batch
// surface (the editor's "Approve N from Claude" and the inbox's). A
// propose-first tool must never make the unguarded path the more prominent
// one; before this, the inbox's "Approve all" had none of the editor's
// guards.
//
// A proposal is batch-eligible iff:
//   1. Claude authored it (humans review each other's work row by row),
//   2. it isn't stale — for slide-content kinds with a recorded base
//      version, the target slide's current version must still match it
//      (approving a stale proposal stacks on top of newer content, silently
//      discarding it), and
//   3. its target (slide_id; else deck_id + kind for deck-level edits) has
//      EXACTLY ONE pending proposal — so a batch can never stack two edits
//      on one target where the later would silently overwrite the earlier.
// Everything else stays in the queue for one-by-one review.

export type BatchProposal = {
  id: string;
  slide_id: string | null;
  kind: string;
  proposed_by_kind: string;
  base_version_id: string | null;
  // Deck-level targets (theme_css / nav_js / deck_title / slide_reorder) key
  // on deck_id + kind so two decks' theme edits can't collide when a
  // cross-deck surface (the inbox) batches. Single-deck callers may omit it.
  deck_id?: string;
};

// Staleness mirrors the editor chip's warning: only the slide-content kinds
// that carry base_version_id can be judged client-side (the legacy three plus
// the bundled slide_edit); anything else counts as fresh here (theme/nav
// staleness needs server-side hashing — the full sheet's job).
const STALE_CHECKED_KINDS = new Set([
  "slide_edit",
  "slide_html",
  "slide_styles",
  "slide_title",
]);

export function isStaleForBatch(
  p: BatchProposal,
  currentVersionBySlide: Map<string, string | null>,
): boolean {
  if (!p.slide_id || p.base_version_id == null) return false;
  if (!STALE_CHECKED_KINDS.has(p.kind)) return false;
  const current = currentVersionBySlide.get(p.slide_id);
  if (current == null) return false;
  return current !== p.base_version_id;
}

function targetKey(p: BatchProposal): string {
  return p.slide_id ?? `${p.deck_id ?? ""}:kind:${p.kind}`;
}

// `pending` is the FULL pending universe for the scope (one deck for the
// editor; every visible deck for the inbox) — the exactly-one rule has to
// count proposals the batch itself would skip, or two stacked edits would
// both look alone. `canApprove` is an optional per-row veto (the editor
// feeds its permission hints; canvas_apply_edit re-checks regardless).
export function eligibleForBatch<T extends BatchProposal>(
  pending: T[],
  currentVersionBySlide: Map<string, string | null>,
  canApprove?: (p: T) => boolean,
): T[] {
  const perTarget = new Map<string, number>();
  for (const p of pending) {
    const key = targetKey(p);
    perTarget.set(key, (perTarget.get(key) ?? 0) + 1);
  }
  return pending.filter((p) => {
    if (p.proposed_by_kind !== "claude") return false;
    if (canApprove && !canApprove(p)) return false;
    if (isStaleForBatch(p, currentVersionBySlide)) return false;
    return (perTarget.get(targetKey(p)) ?? 0) === 1;
  });
}
