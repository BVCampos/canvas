// Shared literal-union types for canvas_deck_edit rows.
//
// Supabase returns enum columns as raw `string` in generated row types, so
// every reader has to either widen its row shape to `string` (which throws
// away the discriminator downstream code relies on for narrowing) or parse
// the value into a union once at the boundary. We do the latter — the union
// types live here, and `asProposalKind` / `asProposerKind` are the narrowing
// helpers RSCs call on the DB value.
//
// `ProposalBase` is the field-set both the inbox row and the in-deck row
// share. Specific row types (InboxProposalRow, PendingProposalRow) extend it
// with their own deck/slide context.
//
// Keep this module client-safe — no Node-only imports — so client components
// (`inbox/proposal-list.tsx`) can import the types directly.

// The single source of truth for the proposal-kind taxonomy. Each kind's
// metadata lives here ONCE; the kind list and the carve-out sets (REVERTABLE /
// LENS) derive from it, so they can't drift from each other. The DB enum
// (canvas_edit_kind) is held in lockstep by a DB-level test
// (tests/db/kind-registry-drift.test.ts) asserting the enum's values equal
// PROPOSAL_KINDS — so adding a kind on one surface and forgetting another fails
// CI instead of silently misclassifying rows (`asProposalKind` would otherwise
// reclassify a forgotten kind as "slide_html").
//
//   revertable — approval yields a slide version with a parent, so
//                revertProposal can restore it (mirrors the MCP revert guard);
//                structural/deck kinds get an "Approved" strip with no Undo.
//   lens       — the before↔after preview can render it as a proposed overlay;
//                slide_create assembles too (the preview route inserts the new
//                slide at its position, and the Lens wipes it against whatever
//                slide is currently there). slide_reorder / slide_delete still
//                can't be assembled, so they fall back to the diff sheet.
const KIND_META = {
  slide_edit: { revertable: true, lens: true },
  slide_html: { revertable: true, lens: true },
  slide_styles: { revertable: true, lens: true },
  slide_title: { revertable: true, lens: true },
  slide_create: { revertable: false, lens: true },
  slide_reorder: { revertable: false, lens: false },
  slide_delete: { revertable: false, lens: false },
  theme_css: { revertable: false, lens: true },
  nav_js: { revertable: false, lens: true },
  deck_title: { revertable: false, lens: false },
} as const satisfies Record<string, { revertable: boolean; lens: boolean }>;

// The canonical kind list, derived from KIND_META's keys. Exported so the DB
// drift test can hold the canvas_edit_kind enum in lockstep with it.
export const PROPOSAL_KINDS = Object.keys(KIND_META) as Array<keyof typeof KIND_META>;
const PROPOSER_KINDS = ["user", "claude"] as const;

// The DB `canvas_edit_status` enum. "withdraw" is not a status — it maps to
// 'rejected' at the action boundary — so it is deliberately absent here.
// Exported for the DB drift test.
export const PROPOSAL_STATUSES = [
  "pending",
  "applied",
  "rejected",
  "superseded",
] as const;

export type ProposalKind = keyof typeof KIND_META;
export type ProposerKind = (typeof PROPOSER_KINDS)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// Single source for proposal-chip.tsx, deck-workspace.tsx, assistant-panel.tsx —
// derived from KIND_META, never a parallel hand-list.
export const REVERTABLE_KINDS: ReadonlySet<ProposalKind> = new Set(
  PROPOSAL_KINDS.filter((k) => KIND_META[k].revertable),
);
export const LENS_KINDS: ReadonlySet<ProposalKind> = new Set(
  PROPOSAL_KINDS.filter((k) => KIND_META[k].lens),
);

// Fields every proposal row carries regardless of where it's rendered. Used
// as a structural base for InboxProposalRow / PendingProposalRow so the
// shared shape only lives in one place.
export type ProposalBase = {
  id: string;
  kind: ProposalKind;
  rationale: string | null;
  proposer_name: string | null;
  proposed_by_kind: ProposerKind;
  created_at: string;
};

// Narrow a raw DB string into the ProposalKind union. We don't want to throw
// in an RSC over a single bad row — better to log + fall back to "slide_html"
// (the most common kind) so the inbox still renders, and let the row-level
// UI hint at the unexpected value via the unknown-label fallback in
// KIND_LABEL.
export function asProposalKind(value: string): ProposalKind {
  if ((PROPOSAL_KINDS as readonly string[]).includes(value)) {
    return value as ProposalKind;
  }
  console.warn(`[proposal-types] unexpected proposal kind: ${value}`);
  return "slide_html";
}

// Narrow the proposer kind. Same forgiving philosophy as asProposalKind — a
// stray value shouldn't blank out the inbox. Defaults to "user", which is
// the safer assumption (no "via Claude" tag rendered).
export function asProposerKind(value: string): ProposerKind {
  if ((PROPOSER_KINDS as readonly string[]).includes(value)) {
    return value as ProposerKind;
  }
  console.warn(`[proposal-types] unexpected proposer kind: ${value}`);
  return "user";
}

// Review order. A reviewer walks the deck top-to-bottom, so the queue should
// follow the slides' physical order rather than when each proposal happened to
// arrive (the old `created_at DESC`, which scattered edits across the deck).
//
//   1. Structural / deck-level proposals first. Theme, deck-title, reorder and
//      new-slide edits have no existing slide position (`slide_position === null`).
//      They change the deck as a whole — or define where a slide will land — so
//      they read best up top, before the slide-by-slide walk.
//   2. Then slide-scoped proposals by their slide's position, ascending
//      (slide 1 → 2 → 3 …).
//   3. Ties — several proposals on the same slide, or two structural ones —
//      break by `created_at` ascending (oldest first) so a slide's edits read
//      in the order they were proposed and the sort is deterministic.
//
// ISO-8601 timestamps compare lexically in chronological order, so plain
// string comparison on `created_at` is correct here.
export type ReviewOrderFields = {
  slide_position: number | null;
  created_at: string;
};

export function compareReviewOrder(
  a: ReviewOrderFields,
  b: ReviewOrderFields,
): number {
  const ap = a.slide_position;
  const bp = b.slide_position;
  if (ap === null && bp !== null) return -1;
  if (ap !== null && bp === null) return 1;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (a.created_at < b.created_at) return -1;
  if (a.created_at > b.created_at) return 1;
  return 0;
}
