// Three-way line merge for rebasing a stale slide proposal onto current content.
//
// A proposal carries the version it was built FROM (base_version_id). If the
// slide moves on before the proposal is approved (a teammate or Claude edits it),
// "approve anyway" today CLOBBERS those newer edits — the documented content-loss
// bug. Instead, rebase: apply the proposal's changes (base -> theirs) on top of
// what's stored now (current). When the two sides touched DISJOINT regions the
// merge is clean and nobody loses work; when they touched the SAME region the
// result is a conflict and the caller falls back to the explicit refuse/clobber
// path rather than silently guessing.
//
// Line-based via node-diff3's merge(a, o, b): o is the common ancestor (base),
// a/b are the two heads (current, theirs). We pass current as `a` so a clean
// merge keeps current's lines as the spine with theirs' changes grafted in.
//
// Pure + dependency-light on purpose: unit-testable with plain strings, no DB.

import { merge } from "node-diff3";

export type TextMergeResult =
  | { clean: true; merged: string }
  | { clean: false };

export function threeWayMergeText(
  base: string,
  current: string,
  theirs: string,
): TextMergeResult {
  // Cheap exact-match short-circuits (also handle the empty-base case cleanly):
  if (current === theirs) return { clean: true, merged: current };
  if (current === base) return { clean: true, merged: theirs }; // current untouched -> take theirs
  if (theirs === base) return { clean: true, merged: current }; // proposal is a no-op vs its base

  const result = merge(current.split("\n"), base.split("\n"), theirs.split("\n"));
  if (result.conflict) return { clean: false };
  return { clean: true, merged: result.result.join("\n") };
}

export type SlideMergeResult =
  | { clean: true; html_body: string; slide_styles: string }
  | { clean: false };

type SlideContent = { html_body: string; slide_styles: string };

// Merge both content fields; a conflict in EITHER fails the whole merge (we never
// half-apply a slide).
export function threeWayMergeSlide(
  base: SlideContent,
  current: SlideContent,
  theirs: SlideContent,
): SlideMergeResult {
  const html = threeWayMergeText(base.html_body, current.html_body, theirs.html_body);
  const styles = threeWayMergeText(base.slide_styles, current.slide_styles, theirs.slide_styles);
  if (!html.clean || !styles.clean) return { clean: false };
  return { clean: true, html_body: html.merged, slide_styles: styles.merged };
}
