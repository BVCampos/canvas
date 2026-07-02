// Compute the propose_slide_patch find/replace edits that reproduce a
// whole-content change — the "actionable" half of the patch nudge.
//
// Why this exists: prod usage (2026-06) showed Claude issuing full
// propose_slide_edit rewrites for tiny tweaks at ~5x the rate of
// propose_slide_patch, despite tool descriptions AND a prose nudge that both say
// "prefer patch". A prose steer didn't move the behavior. So when a full edit
// barely changes the slide, we hand back the EXACT patch it could have sent — a
// concrete, copy-runnable example riding the tool RESULT, not advice. Every
// returned patch is verified against applySlidePatch (the real engine), so we
// never suggest one that wouldn't reproduce the change; if we can't build a
// clean, uniquely-anchored patch we return null and the caller falls back to the
// prose hint.
//
// Pure module on purpose: no Supabase, no node-only imports — unit-testable with
// plain strings. (`diff` is browser-safe.)

import { diffLines } from "diff";
import {
  applySlidePatch,
  type SlidePatchEdit,
  type SlidePatchField,
} from "./slide-patch";

// A suggestion is only useful if it's small and unambiguous; past these bounds
// we bail and let the full edit stand (the caller falls back to a prose hint).
const SUGGEST_MAX_HUNKS = 8; // more separate change-clusters than this = a real rewrite, not an adjustment
const SUGGEST_MAX_CONTEXT_LINES = 3; // give up if a hunk can't be uniquely anchored within this many context lines
const SUGGEST_MAX_LINES = 800; // slide too large to cheaply diff — not worth suggesting

// Split into lines that KEEP their trailing "\n" (the last line may lack one),
// so concatenating adjacent slices reproduces the source byte-for-byte.
function linesWithEnds(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function lastLines(s: string, n: number): string {
  if (n <= 0) return "";
  return linesWithEnds(s).slice(-n).join("");
}
function firstLines(s: string, n: number): string {
  if (n <= 0) return "";
  return linesWithEnds(s).slice(0, n).join("");
}
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Reduce a whole-content (before → after) change to the minimal set of
 * {find, replace} edits propose_slide_patch would take, or null when no compact,
 * uniquely-anchored, verified patch exists (large rewrite, ambiguous anchors,
 * etc.). Field-agnostic on strings; `field` tags the returned edits' `in` and
 * selects which field the internal verification applies them to.
 */
export function computeSlidePatch(
  before: string,
  after: string,
  field: SlidePatchField = "html_body",
): SlidePatchEdit[] | null {
  if (before === after) return null;
  if (
    before.split("\n").length > SUGGEST_MAX_LINES ||
    after.split("\n").length > SUGGEST_MAX_LINES
  ) {
    return null;
  }

  const parts = diffLines(before, after);

  // Group consecutive added/removed parts into change "hunks", each bounded by
  // the unchanged parts on either side (used as uniqueness anchors).
  type Hunk = { removed: string; added: string; prev: string; next: string };
  const hunks: Hunk[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].added && !parts[i].removed) continue;
    const prev =
      i > 0 && !parts[i - 1].added && !parts[i - 1].removed ? parts[i - 1].value : "";
    let removed = "";
    let added = "";
    let j = i;
    for (; j < parts.length && (parts[j].added || parts[j].removed); j++) {
      if (parts[j].removed) removed += parts[j].value;
      else added += parts[j].value;
    }
    const next = j < parts.length ? parts[j].value : "";
    hunks.push({ removed, added, prev, next });
    i = j - 1;
  }
  if (hunks.length === 0 || hunks.length > SUGGEST_MAX_HUNKS) return null;

  const edits: SlidePatchEdit[] = [];
  for (const h of hunks) {
    let made: SlidePatchEdit | null = null;
    // Grow context until `find` is non-empty AND unique in the source. A pure
    // insertion (removed === "") needs at least one context line to anchor.
    for (let c = 0; c <= SUGGEST_MAX_CONTEXT_LINES; c++) {
      const ctxBefore = lastLines(h.prev, c);
      const ctxAfter = firstLines(h.next, c);
      const find = ctxBefore + h.removed + ctxAfter;
      const replace = ctxBefore + h.added + ctxAfter;
      if (find === "" || find === replace) continue;
      if (countOccurrences(before, find) === 1) {
        made = field === "html_body" ? { find, replace } : { find, replace, in: field };
        break;
      }
    }
    if (!made) return null; // couldn't anchor this hunk uniquely
    edits.push(made);
  }

  // Verify against the real engine: applying the suggestion to `before` must
  // reproduce `after` exactly. Anything else (overlapping hunks, a context
  // collision after an earlier edit rewrote the string) is discarded rather than
  // handed back wrong.
  const input =
    field === "slide_styles"
      ? { html_body: "", slide_styles: before }
      : { html_body: before, slide_styles: "" };
  const res = applySlidePatch(input, edits);
  if (!res.ok) return null;
  const produced = field === "slide_styles" ? res.slide_styles : res.html_body;
  if (produced !== after) return null;

  return edits;
}
