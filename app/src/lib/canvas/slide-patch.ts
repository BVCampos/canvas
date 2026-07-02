// Server-side find/replace for slide content — the engine behind the
// propose_slide_patch MCP tool.
//
// Why this exists: propose_slide_edit takes whole-content replacements, so a
// one-line copy tweak on a large (often PPTX-imported) slide forces the MCP
// client to regenerate tens of KB of HTML — that regeneration is where "Claude
// takes forever on small adjustments" comes from. A patch proposal instead
// carries only the changed snippets; we resolve them against the slide's
// current stored content here and persist the SAME kind='slide_edit' proposal
// shape, so review/approve/apply paths see no difference.
//
// Pure module on purpose: no Supabase, no node-only imports — unit-testable
// with plain strings.

export type SlidePatchField = "html_body" | "slide_styles";

export type SlidePatchEdit = {
  /** Exact text to find in the slide's current content (whitespace-sensitive). */
  find: string;
  /** Replacement text. May be empty (deletes the found text). */
  replace: string;
  /** Which stored field to patch. Defaults to html_body. */
  in?: SlidePatchField;
  /** Replace every occurrence instead of requiring a unique match. */
  replace_all?: boolean;
};

export type SlidePatchResult =
  | {
      ok: true;
      html_body: string;
      slide_styles: string;
      /** Which fields actually differ from the input after all edits. */
      touched: { html_body: boolean; slide_styles: boolean };
    }
  | { ok: false; error: string };

export const MAX_PATCH_EDITS = 50;

// Count non-overlapping occurrences. split is safe here (no regex semantics).
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Single-occurrence replacement via slicing — String.replace would reinterpret
// `$&`-style patterns in the replacement text, which slide HTML can contain.
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

export function applySlidePatch(
  current: { html_body: string; slide_styles: string },
  edits: SlidePatchEdit[],
): SlidePatchResult {
  if (edits.length === 0) {
    return { ok: false, error: "edits must contain at least one {find, replace} entry" };
  }
  if (edits.length > MAX_PATCH_EDITS) {
    return {
      ok: false,
      error: `too many edits (${edits.length}; max ${MAX_PATCH_EDITS}) — for a rewrite that large, use propose_slide_edit with full replacement content`,
    };
  }

  const working = { html_body: current.html_body, slide_styles: current.slide_styles };

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const field: SlidePatchField = edit.in ?? "html_body";
    if (edit.find.length === 0) {
      return { ok: false, error: `edit #${i + 1}: "find" must be non-empty` };
    }
    const occurrences = countOccurrences(working[field], edit.find);
    if (occurrences === 0) {
      return {
        ok: false,
        error:
          `edit #${i + 1}: "find" text not found in ${field}. The text must match the slide's CURRENT stored content exactly (whitespace included) — call read_slide and copy the text verbatim. Note that earlier edits in this call may already have rewritten it.`,
      };
    }
    if (occurrences > 1 && !edit.replace_all) {
      return {
        ok: false,
        error:
          `edit #${i + 1}: "find" matches ${occurrences} places in ${field} — extend it with surrounding context to make it unique, or pass replace_all=true to change every occurrence.`,
      };
    }
    working[field] = edit.replace_all
      ? working[field].split(edit.find).join(edit.replace)
      : replaceOnce(working[field], edit.find, edit.replace);
  }

  const touched = {
    html_body: working.html_body !== current.html_body,
    slide_styles: working.slide_styles !== current.slide_styles,
  };
  if (!touched.html_body && !touched.slide_styles) {
    return {
      ok: false,
      error: "patch produced no changes — every edit's replace equals its find",
    };
  }

  return { ok: true, ...working, touched };
}
