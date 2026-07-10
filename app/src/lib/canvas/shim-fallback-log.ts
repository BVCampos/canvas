// Observability for the fixed-px viewport-shim squeeze fallback.
//
// assembleDeckHtml auto-rebinds fixed-pixel standalone/PPTX decks onto Canvas's
// viewport model. When it can PARSE the deck's design width it scales the deck
// (viewportShimZoomCss); when it can't, it falls back to the classic 100vw
// squeeze — which for a fixed-px deck renders with the exact pre-PR scramble.
// That dead end (e.g. `width: calc(1920px - 40px)`, `min(1280px, 100%)`) fires
// silently: the deck trips needsViewportShim but detectFixedSlideSize returns
// null, and nothing records that a render went out scrambled.
//
// assembleDeckHtml is pure and also runs CLIENT-side (proposal-diff.tsx), so we
// can't log from inside it. This helper lives with the SERVER callers instead
// (the preview API routes + export builder) and fires the fire-and-forget
// logUsage hook on exactly that fallback path. Fire-and-forget: logUsage
// swallows its own failures, so telemetry can never break a render.

import { needsViewportShim, detectFixedSlideSize } from "@/lib/canvas/assemble";
import { logUsage, type UsageSurface } from "@/lib/usage/log";

/**
 * Fire the `deck.viewport_shim_fallback` usage event iff this deck's CSS lands
 * on the squeeze fallback that scrambles fixed-px decks — the same gate
 * assembleDeckHtml uses to pick the shim variant: needs the shim, ships no
 * `--slide-zoom` of its own, and has no parseable design width. A deck that
 * scales itself (--slide-zoom) or parses cleanly stays silent. Cheap and
 * never-throws, so call sites can drop it inline before rendering.
 */
export function logViewportShimFallback(args: {
  theme_css: string;
  nav_js: string;
  surface: UsageSurface;
  deck_id?: string | null;
  user_id?: string | null;
  workspace_id?: string | null;
}): void {
  const { theme_css, nav_js } = args;
  if (!needsViewportShim(theme_css)) return;
  if (/--slide-zoom/.test(theme_css) || /--slide-zoom/.test(nav_js)) return;
  if (detectFixedSlideSize(theme_css) != null) return;
  logUsage({
    event: "deck.viewport_shim_fallback",
    surface: args.surface,
    deck_id: args.deck_id ?? null,
    user_id: args.user_id ?? null,
    workspace_id: args.workspace_id ?? null,
    status: "error",
  });
}
