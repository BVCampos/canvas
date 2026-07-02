// Pure builder for a member's "propose a hand edit" row. A workspace member who
// can't direct-save a slide (not its owner/creator, not an admin) edits it in
// the same Adjust / Edit-text / Inspect surfaces a direct editor uses, but on
// Save the change is routed through a PENDING proposal instead of an immediate
// commit. This module shapes the canvas_deck_edit insert payload for that path.
//
// It mirrors the MCP `propose_slide_edit` row exactly (lib/canvas/mcp/tools.ts):
// kind='slide_edit', new_content=null, new_slide_payload carrying html_body
// (and optionally slide_styles / title), so the reviewer's diff, the apply RPC,
// and the staleness guard all treat it identically to a Claude-authored
// slide_edit. The one intended difference is proposed_by_kind: a human's hand
// edit is 'user', not 'claude'. (The canvas_deck_edit CHECK constraint only
// permits 'user' | 'claude' — there is no 'human' — so 'user' is the human
// kind, same as revertProposal and the direct-edit RLS path use.)
//
// Client-safe: no Node-only imports, so the workspace island can call the
// builder before the server round-trip and the tests can import it under node.
// The shaping that has to stay in lockstep with the
// canvas_deck_edit_content_shape_chk CHECK constraint (migration 0032) lives
// here so it's unit-testable without rendering React or hitting the DB.

// The slide_edit payload the apply RPC reads. At least one of html_body /
// slide_styles / title must be a string (the CHECK constraint), and each
// present field is applied; an absent field keeps the slide's current value on
// approval. The in-place edit surfaces only ever change html_body, so that's
// the one field this builder requires — slide_styles / title stay optional so
// the same shape can carry an inspector edit that rewrote scoped CSS too.
export type ProposeSlideEditPayload = {
  html_body: string;
  slide_styles?: string;
  title?: string;
};

// The full canvas_deck_edit insert row for a human slide_edit proposal, minus
// the columns the server action fills from the auth context + DB lookups
// (workspace_id, deck_id, proposed_by). Kept as a typed object so the action's
// insert and the test assert against the same shape.
export type ProposeSlideEditRow = {
  slide_id: string;
  kind: "slide_edit";
  proposed_by_kind: "user";
  new_content: null;
  new_slide_payload: ProposeSlideEditPayload;
  rationale: string | null;
  status: "pending";
  // The version the editor opened against — stamped at propose time so the
  // chip's staleness guard (slide moved on since) can fire, exactly as the MCP
  // tool stamps slide.current_version_id. May be null for a slide with no
  // version row yet.
  base_version_id: string | null;
};

export type BuildProposeRowResult =
  | { ok: true; row: ProposeSlideEditRow }
  | { ok: false; error: string };

// Wrap bare slide markup in a single <section class="slide">…</section> the way
// the MCP tool's ensureSlideSectionWrap does — the assemble + preview pipeline
// keys on a top-level <section>. When the body already opens with a <section>,
// trust the caller (intentional class modifiers like `slide cover` or a custom
// theme class). Mirrors lib/canvas/mcp/tools.ts; kept local so this file stays
// client-safe (that module is server-only).
export function ensureSlideSectionWrap(htmlBody: string): string {
  if (/^\s*<section\b/i.test(htmlBody)) return htmlBody;
  return `<section class="slide">${htmlBody}</section>`;
}

// Shape the insert row, or an { error } describing why the current edit isn't
// proposable. The only hard rule mirrors saveSlideHtmlDirect's empty_html guard
// (a slide needs markup) and the slide_html branch of buildProposalEditPatch —
// the rest of the payload is optional and carried verbatim.
export function buildProposeSlideEditRow(args: {
  slideId: string;
  htmlBody: string;
  slideStyles?: string;
  title?: string;
  rationale?: string;
  baseVersionId: string | null;
}): BuildProposeRowResult {
  if (args.htmlBody.trim() === "") {
    return { ok: false, error: "The slide HTML can't be empty." };
  }

  const payload: ProposeSlideEditPayload = {
    html_body: ensureSlideSectionWrap(args.htmlBody),
  };
  // Only carry slide_styles / title when the caller actually supplied them —
  // an omitted field keeps the slide's current value on apply, an explicit ""
  // clears it. The in-place text/visual editors send html_body only; the
  // inspector may also send slide_styles.
  if (args.slideStyles !== undefined) payload.slide_styles = args.slideStyles;
  if (args.title !== undefined) payload.title = args.title.trim();

  const rationale =
    args.rationale && args.rationale.trim() !== "" ? args.rationale.trim() : null;

  return {
    ok: true,
    row: {
      slide_id: args.slideId,
      kind: "slide_edit",
      proposed_by_kind: "user",
      new_content: null,
      new_slide_payload: payload,
      rationale,
      status: "pending",
      base_version_id: args.baseVersionId,
    },
  };
}
