// Pure builder for the in-place proposal-edit patch. Extracted from
// ProposalEditForm so the per-kind payload shaping — the part that has to stay
// in lockstep with canvas_update_edit's validation and the
// canvas_deck_edit_content_shape_chk CHECK constraint — is unit-testable
// without rendering React.
//
// Client-safe: no Node-only imports (the form imports it in the browser, the
// tests import it under node). The ProposalEditPatch type is type-only (erased
// at runtime), so importing it from the "use server" actions module pulls in no
// server code.

import type { ProposalEditPatch } from "@/app/canvases/proposal-actions";
import type { EditKind } from "@/components/proposal-diff";

// The text-content kinds carry their whole content in a single new_content
// string. slide_title / deck_title are one-liners; the rest are code blocks.
export const TEXT_CONTENT_KINDS: readonly EditKind[] = [
  "slide_html",
  "slide_styles",
  "slide_title",
  "theme_css",
  "nav_js",
  "deck_title",
];

export const SINGLE_LINE_KINDS: readonly EditKind[] = [
  "slide_title",
  "deck_title",
];

export type ProposalEditFormState = {
  // Single text-content kinds.
  content: string;
  // Rationale (every kind).
  rationale: string;
  // slide_edit: which fields the proposal touches (only these are editable +
  // resent) and their current values.
  editKeys: { html_body: boolean; slide_styles: boolean; title: boolean };
  slideEdit: { html_body: string; slide_styles: string; title: string };
  // slide_create.
  slideCreate: {
    position: number;
    title: string;
    html_body: string;
    slide_styles: string;
  };
  // slide_reorder: the unchanged order payload, resent verbatim so the RPC's
  // payload validation passes (the order isn't editable in this surface).
  reorderPayload: Record<string, unknown> | null;
};

export type BuildResult = ProposalEditPatch | { error: string };

export function isBuildError(r: BuildResult): r is { error: string } {
  return "error" in r;
}

// Build the patch for `updateProposal`, or an { error } describing why the
// current field state isn't submittable. Mirrors canvas_update_edit's per-kind
// validation so the client fails fast with a friendly message before the RPC
// round-trip.
export function buildProposalEditPatch(
  kind: EditKind,
  revision: number,
  s: ProposalEditFormState,
): BuildResult {
  const base = {
    rationale: s.rationale.trim() === "" ? null : s.rationale,
    expected_revision: revision,
  };

  if (TEXT_CONTENT_KINDS.includes(kind)) {
    // Mirror the server's actual rules — don't be stricter than it. Only
    // deck_title (enforced in canvas_apply_edit) and slide_html (matches
    // saveSlideHtmlDirect's empty_html guard — a slide needs markup) must be
    // non-empty. Slide CSS, theme CSS, nav JS and a slide's sidebar label may
    // all legitimately be emptied, so don't block those.
    if (kind === "deck_title" && s.content.trim() === "") {
      return { error: "The deck title can't be empty." };
    }
    if (kind === "slide_html" && s.content.trim() === "") {
      return { error: "The slide HTML can't be empty." };
    }
    return { ...base, new_content: s.content };
  }

  if (kind === "slide_edit") {
    const next: Record<string, unknown> = {};
    if (s.editKeys.html_body) next.html_body = s.slideEdit.html_body;
    if (s.editKeys.slide_styles) next.slide_styles = s.slideEdit.slide_styles;
    if (s.editKeys.title) next.title = s.slideEdit.title;
    if (Object.keys(next).length === 0) {
      return { error: "This edit has no fields to change." };
    }
    return { ...base, new_slide_payload: next };
  }

  if (kind === "slide_create") {
    if (s.slideCreate.html_body.trim() === "") {
      return { error: "The new slide needs HTML." };
    }
    if (!Number.isInteger(s.slideCreate.position) || s.slideCreate.position < 0) {
      return { error: "Position must be a whole number ≥ 0." };
    }
    return {
      ...base,
      new_slide_payload: {
        position: s.slideCreate.position,
        title: s.slideCreate.title,
        html_body: s.slideCreate.html_body,
        slide_styles: s.slideCreate.slide_styles,
      },
    };
  }

  // slide_reorder: rationale-only here; resend the unchanged order so the RPC
  // payload validation passes.
  if (kind === "slide_reorder") {
    return { ...base, new_slide_payload: s.reorderPayload ?? {} };
  }

  // slide_delete: no content; rationale only.
  return base;
}
