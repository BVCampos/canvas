import {
  EXPORT_CHROME_CSS,
  EXPORT_CHROME_HTML,
  EXPORT_CHROME_JS,
  EXPORT_FIT_CSS,
  EXPORT_FIT_JS,
  EXPORT_PRINT_CSS,
  EXPORT_PRINT_JS,
} from "./export-chrome";
import { DRAG_GEOMETRY_JS } from "./drag-position";

// Assembler — turns a deck (theme + ordered slides + nav) back into a single
// HTML string. Used for two things:
//   1. The live iframe preview (/api/decks/[id]/preview) — mode: "preview"
//   2. The export endpoint (/api/decks/[id]/export) — mode: "export"
//
// What this file does beyond simple concatenation:
//
// 1. **Restore the `<div id="slides" class="slides">` wrapper** that
//    Claude-generated decks expect. The parser strips the wrapper down to the
//    raw `<section>` list; the deck's nav script (which calls
//    `document.getElementById('slides')`) needs the id back or all in-deck
//    nav (prev/next/dots/keyboard) silently no-ops.
//
// 2. **Inject hidden chrome stubs** (`#prevBtn`, `#nextBtn`, `#dotsNav`,
//    `#current`, `#total`, `#hint`). These used to be the *visible* nav and
//    leaned on the deck's theme_css to style them — which broke any deck
//    whose theme didn't ship `.navbar` rules. The visible chrome now lives
//    in the host React app for previews, and in `export-chrome.ts` for
//    standalone exports. The stubs stay so deck nav.js scripts that bind
//    via `getElementById` keep working — and `CANVAS_CONTROLLER.navigate()`
//    writes through them directly (`#current`, dot `.active` classes,
//    `prevBtn.disabled`) so host chrome state survives a round trip.
//
// 3. **In preview mode, inject `EMBEDDED_GUARD` before the deck nav.js**.
//    The deck's nav.js wires `document.addEventListener('keydown', ...)`
//    and `slidesEl.addEventListener('touch*', ...)` to drive a horizontal
//    carousel. In Canvas the host owns navigation — running both side by
//    side caused the slide to bounce between targets when host + deck +
//    controller all chased the same transform. The guard intercepts
//    `addEventListener` for those two specific surfaces (document keys,
//    `#slides` touch) and drops the registrations. Per-element keydown
//    handlers used for keyboard activation (e.g. dores modal `.dot`
//    buttons) are left alone. Not injected in export mode — the standalone
//    deck file relies on its own keyboard nav.
//
// 4. **Inject a `canvas-controller` script** that drives in-iframe navigation
//    directly via DOM mutation (no event dispatch, no hidden-dot click) in
//    response to `postMessage` and broadcasts the current position back so
//    the host chrome stays in sync. See the protocol docs above
//    CANVAS_CONTROLLER below.
//
// 5. **In export mode, inline a standalone chrome bundle** (`.cv-*` scoped
//    CSS + small vanilla JS) so the downloaded HTML file navigates on its
//    own without the Canvas host. See `export-chrome.ts`.

export type AssembleSlide = {
  position: number;
  title: string;
  html_body: string;
  slide_styles?: string | null;
};

// preview — rendered inside Canvas's iframe with host-side chrome.
//   The deck DOM still ships hidden #prevBtn/#nextBtn/#dotsNav/#current/
//   #total stubs so existing deck nav.js scripts that bind via
//   getElementById keep working.
// export — standalone HTML downloaded by the user. The host isn't there,
//   so we inline a small visible chrome bundle (scoped to .cv-*) so the
//   exported file navigates on its own.
export type AssembleMode = "preview" | "export";

export type AssembleInput = {
  title: string;
  lang?: string;
  theme_css: string;
  nav_js: string;
  meta?: Record<string, unknown> | null;
  slides: AssembleSlide[];
  mode?: AssembleMode;
  // Suppress the click-to-edit hint overlay (`<div class="hint" id="hint">`).
  // Set true for proposal preview iframes: the hint reads "click on text to
  // edit", which is a contract the editor honors (via Claude/MCP) but the
  // before/after proposal iframes do not — surfacing it there is misleading.
  // Implementation: we inject a tiny CSS rule that hides `.hint, #hint`,
  // overrides any `::before`/`::after` content from the deck's theme, AND
  // omit the hint stub from the body so deck nav.js trying to write into
  // it via `textContent` simply no-ops on the null. Live editor preview
  // (default) keeps the hint; only the proposal-diff caller toggles this.
  suppressEditHint?: boolean;
};

/**
 * Canvas's slide contract: the importer strips a deck down to
 * `.deck > #slides > section.slide` and the CANVAS_CONTROLLER drives the strip
 * by `translateX(-i*100vw)`, so the iframe's own viewport IS the scaling stage
 * (see deck-viewer.tsx). That only works when each slide is one viewport wide.
 * A Canvas-native deck (tests/fixtures/seed-deck.html) honors it:
 * `#slides{display:flex}` + `.slide{flex:0 0 100vw}`.
 *
 * Standalone / PPTX-converted decks instead pin slides to a fixed pixel size
 * (`.slide{width:1280px;height:720px}`) inside `.stage-area/.viewport/.track`
 * wrappers that the parser strips. With those wrappers gone, `.deck`/`#slides`
 * are unstyled blocks and the slides collapse into a vertical stack of fixed
 * boxes inside an `overflow:hidden` body — only the top-left of slide 1 ever
 * shows, navigation can't scroll, and the deck renders blank (the fixed-px weekly-deck
 * regression). The shims below re-bind such a deck onto Canvas's structure —
 * this squeeze variant for the kit, which scales itself: its embedded
 * `zoom: var(--slide-zoom)` shrinks the px content to fill the squeezed box,
 * and vw lengths are zoom-immune, so the 100vw rebind is exactly the box its
 * adapter expects — and the zoom variant (viewportShimZoomCss) for fixed-px
 * decks that don't scale themselves. `#slides > .slide` (specificity 1,1,0)
 * wins over the deck's own `.slide` (0,1,0) without `!important`, so it stays
 * overridable.
 */
const VIEWPORT_SHIM_CSS = `
html, body { width: 100%; height: 100%; margin: 0; }
body { overflow: hidden; }
.deck { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
#slides, .slides { display: flex; width: 100vw; height: 100vh; transition: transform .35s ease; }
#slides > .slide, #slides > section.slide,
.slides > .slide, .slides > section.slide {
  flex: 0 0 100vw; width: 100vw; height: 100vh;
  min-width: 0; max-width: none; overflow: hidden;
}
`.trim();

/**
 * The declaration body of every `.slide { … }` rule in a CSS string. The
 * `[^}]*` body also reaches a `.slide` block nested inside an at-rule (e.g.
 * `@media (…) { .slide { … } }`) — intentional for needsViewportShim, whose
 * gating must see those; detectFixedSlideSize strips at-rule blocks first (see
 * stripAtRuleBlocks) so it reads base rules only.
 *
 * KNOWN LIMITATION: only bare `.slide { … }` blocks are seen. A selector list
 * or compound selector (`.slide, .card { … }`, `.slide.dark { … }`) is invisible
 * to this scan — a pre-existing bound on the shim's reach, not introduced here.
 */
function slideDeclBlocks(css: string): string[] {
  return [...css.matchAll(/\.slide\s*\{([^}]*)\}/gi)].map((m) => m[1]);
}

/**
 * Drop `@media` / `@supports` / `@container` blocks — including nested braces —
 * so only base (non-conditional) rules remain. A regex can't balance braces, so
 * we scan to each at-rule then brace-count to its matching close.
 * detectFixedSlideSize uses this so a responsive override
 * (`@media (max-width: 1440px) { .slide { width: 1200px } }`) can't be mistaken
 * for the deck's authored design size.
 */
function stripAtRuleBlocks(css: string): string {
  const atRule = /@(?:media|supports|container)\b/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = atRule.exec(css)) !== null) {
    const open = css.indexOf("{", atRule.lastIndex);
    if (open === -1) break;
    let depth = 1;
    let i = open + 1;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out += css.slice(cursor, m.index); // keep everything before the at-rule
    cursor = i; // resume after its matching close brace
    atRule.lastIndex = i;
  }
  return out + css.slice(cursor);
}

// The fixed px width a `.slide` block pins: an explicit `width` decl first,
// else the basis of a `flex` / `flex-basis` shorthand. Decimal px accepted so
// `width: 1280.5px` parses (integer part ≥ 3 digits, matching needsViewportShim).
function blockFixedWidth(decls: string): number | null {
  const w =
    decls.match(/(?:^|[;{\s])width\s*:\s*(\d{3,}(?:\.\d+)?)px/i) ??
    decls.match(
      /(?:^|[;{\s])(?:flex-basis|flex)\s*:\s*(?:[\d.]+\s+[\d.]+\s+)?(\d{3,}(?:\.\d+)?)px/i,
    );
  return w ? parseFloat(w[1]) : null;
}

// The fixed px height a `.slide` block pins, if any. Threshold is \d{3,} (same
// as width) so a small px height (a `height: 90px` footer-ish rule) is not
// mistaken for the design height and used to crop the slide.
function blockFixedHeight(decls: string): number | null {
  const h = decls.match(/(?:^|[;{\s])height\s*:\s*(\d{3,}(?:\.\d+)?)px/i);
  return h ? parseFloat(h[1]) : null;
}

/**
 * True when the deck ships the fixed-pixel standalone-carousel signature and
 * does NOT already conform to Canvas's viewport-unit flex strip — i.e. it needs
 * VIEWPORT_SHIM_CSS. We scan every `.slide { … }` rule (at-rule-nested ones
 * included, so a responsive `100vw` still opts the deck out): a `100vw` width
 * means the deck is already Canvas-native (leave it alone); otherwise a fixed
 * pixel width pinned via `width` / `flex` / `flex-basis` is the standalone/PPTX
 * tell. Decimal px counts too (`1280.5px`), matching detectFixedSlideSize. The
 * property boundary `(?:^|[;{\\s])` keeps `max-width` / `min-width` from
 * tripping the match, and `flex\\s*:` won't catch `flex-direction`.
 *
 * KNOWN LIMITATION: only bare `.slide { … }` blocks are seen; a selector list
 * or compound selector (`.slide, .card { … }`, `.slide.dark { … }`) is invisible
 * to this scan (see slideDeclBlocks) — a pre-existing bound on the fix's reach.
 */
export function needsViewportShim(theme_css: string): boolean {
  const decls = slideDeclBlocks(theme_css).join(";");
  if (!decls) return false;
  if (/\b100vw\b/i.test(decls)) return false; // already viewport-width → conforms
  return /(?:^|[;{\s])(?:width|flex|flex-basis)\s*:\s*[^;}]*\d{3,}(?:\.\d+)?px/i.test(decls);
}

/**
 * The design-stage size a fixed-px deck was authored at, for the scale-aware
 * zoom shim (viewportShimZoomCss). INVARIANT: only ever called on decks where
 * needsViewportShim is true — it's the second gate behind it (see
 * assembleDeckHtml), not a standalone classifier.
 *
 * Reads BASE rules only: at-rule blocks are stripped first (stripAtRuleBlocks),
 * so a responsive override (`@media (max-width: 1440px) { .slide { width:
 * 1200px } }`) can't be read as the authored size and upscale the deck. Width
 * comes from the first base `.slide` block that pins one (a `width` decl, else a
 * `flex` / `flex-basis` px basis); height is read from that SAME block, so
 * `.slide { width: 1920px } .slide { height: 90px }` yields
 * `{ width: 1920, height: null }` (a stray small height never crops the slide).
 * Returns null — falling back to the squeeze shim — when no base block pins a
 * fixed width, or when two base blocks disagree on it (a cheap bail rather than
 * guessing which is the design width).
 */
export function detectFixedSlideSize(
  theme_css: string,
): { width: number; height: number | null } | null {
  const blocks = slideDeclBlocks(stripAtRuleBlocks(theme_css));
  let width: number | null = null;
  let widthBlock: string | null = null;
  for (const decls of blocks) {
    const w = blockFixedWidth(decls);
    if (w == null) continue;
    if (width == null) {
      width = w;
      widthBlock = decls;
    } else if (w !== width) {
      return null; // base blocks pin different widths → don't guess; squeeze
    }
  }
  if (width == null || widthBlock == null) return null;
  return { width, height: blockFixedHeight(widthBlock) };
}

/**
 * Scale-aware variant of VIEWPORT_SHIM_CSS for fixed-px decks that ship NO
 * scaling of their own (no `--slide-zoom` anywhere — the kit-derived orphan:
 * `.slide{width:1920px}` with px typography and nothing to shrink it). The
 * squeeze shim rebinds the slide BOX to 100vw but leaves the px content at
 * design scale, so the deck only looks right when the viewport happens to be
 * ≈ design width — in the editor pane or on a laptop the type wraps and the
 * slide crops ("scrambled"). Instead we keep the slide at its design size and
 * scale it the way the kit does in canvas-embedded mode: CSS
 * `zoom: var(--slide-zoom)` with the companion script below setting
 * --slide-zoom = innerWidth / designWidth. Each slide then RENDERS at exactly
 * 100vw, so the controller's translate math, zoom-settle observers, and the
 * editor's sectionScale() all treat it exactly like a kit deck. `margin: 0`
 * flattens vertical-stack gaps (`.slide + .slide{margin-top:32px}`) that
 * would skew the horizontal strip — the same reset the kit's embedded rules
 * make. Kit decks themselves (--slide-zoom present) keep the squeeze shim:
 * their embedded `zoom: var(--slide-zoom)` already shrinks the px content to
 * fill the 100vw box, and vw lengths are zoom-immune, so the rebind is exactly
 * the box the kit's adapter expects — no second setZoom to double up on.
 */
function viewportShimZoomCss(size: { width: number; height: number | null }): string {
  const height = size.height ? ` height: ${size.height}px;` : "";
  return `
html, body { width: 100%; height: 100%; margin: 0; }
body { overflow: hidden; }
.deck { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
#slides, .slides { display: flex; width: 100vw; height: 100vh; transition: transform .35s ease; }
#slides > .slide, #slides > section.slide,
.slides > .slide, .slides > section.slide {
  flex: 0 0 ${size.width}px; width: ${size.width}px;${height}
  min-width: 0; max-width: none; margin: 0; overflow: hidden;
  zoom: var(--slide-zoom, 1);
}
`.trim();
}

/**
 * Companion width-fit driver for viewportShimZoomCss — the deck has no setZoom
 * of its own, so the shim supplies one. Mirrors kit.js's embedded branch
 * (--slide-zoom = innerWidth/designWidth, set on <html> so CANVAS_CONTROLLER's
 * style MutationObserver re-asserts the strip offset after each change). In
 * export mode EXPORT_FIT_JS then wins the var over this width-only value with
 * its fit-both letterbox — the same tug-of-war it already plays with kit decks.
 */
function viewportShimZoomJs(designWidth: number): string {
  return `
(function () {
  function setShimZoom() {
    var vw = window.innerWidth;
    if (!vw) return;
    document.documentElement.style.setProperty("--slide-zoom", (vw / ${designWidth}).toFixed(4));
  }
  setShimZoom();
  window.addEventListener("resize", setShimZoom);
  window.addEventListener("load", setShimZoom);
})();
`.trim();
}

export function assembleDeckHtml(input: AssembleInput): string {
  const mode: AssembleMode = input.mode ?? "preview";
  const lang = typeof input.meta?.lang === "string" ? (input.meta.lang as string) : input.lang ?? "en";
  const viewport =
    typeof input.meta?.viewport === "string"
      ? (input.meta.viewport as string)
      : "width=device-width, initial-scale=1.0";

  const sortedSlides = [...input.slides].sort((a, b) => a.position - b.position);

  const slideStyles = sortedSlides
    .map((s) => (s.slide_styles ?? "").trim())
    .filter((s) => s.length > 0)
    .join("\n\n");

  const body = sortedSlides
    .map((s) => tagSection(stripContenteditable(s.html_body), s.position))
    .join("\n");

  // Multi-slide decks always get the hidden chrome stubs back so the deck's
  // own nav.js can wire up its keyboard handlers via getElementById. The
  // visible chrome is host-rendered (preview) or shipped as a scoped bundle
  // (export). Single-slide decks need neither.
  const navChrome = sortedSlides.length > 1 ? navChromeHtml(sortedSlides.length) : "";

  // Export mode bundles a visible, .cv-* scoped chrome so the downloaded
  // file can navigate without the Canvas host. Preview mode skips it — the
  // React DeckChrome component handles user-facing nav.
  const exportChromeMarkup = mode === "export" && sortedSlides.length > 1
    ? EXPORT_CHROME_HTML
    : "";
  const exportChromeStyle = mode === "export" && sortedSlides.length > 1
    ? `<style>\n${EXPORT_CHROME_CSS}\n</style>`
    : "";
  const exportChromeScript = mode === "export" && sortedSlides.length > 1
    ? `<script>\n${EXPORT_CHROME_JS}\n</script>`
    : "";

  // Standalone marker for the exported file. In export mode there is no Canvas
  // host posting `canvas:navigate`, so CANVAS_CONTROLLER must drive the
  // carousel itself — its keyboard handler navigates locally instead of
  // forwarding keys upward, and the visible `.cv-chrome` buttons call
  // `window.__canvasNavigate`. Emitted BEFORE the controller script so
  // isStandalone() reads it. Never set in preview, where the host owns
  // navigation and the controller only forwards keys.
  const standaloneFlagScript =
    mode === "export" ? `<script>window.__canvasStandalone = true;</script>` : "";

  // Export mode also ships a print stylesheet so "Export HTML" → "Save as PDF"
  // paginates one slide per 16:9 landscape page instead of collapsing the
  // carousel to a single US-Letter-portrait page of slide 1. Gated on export
  // mode ONLY (not slide count — single-slide decks must still print as one
  // correctly-sized page). Every rule is print-scoped (media="print" on the
  // tag + an inner @media print), so the on-screen exported deck is untouched.
  // See EXPORT_PRINT_CSS. Placed last among the <head> styles below so it wins
  // the cascade over any print rules a deck's own theme_css might ship.
  const exportPrintStyle =
    mode === "export"
      ? `<style media="print">\n${EXPORT_PRINT_CSS}\n</style>`
      : "";

  // Companion print-fit script (same export-only gate, single-slide decks
  // included): scales an over-tall slide down to one 720px page instead of
  // letting it fragment across two. Self-wires to beforeprint/afterprint for
  // the manual Cmd+P path; the PDF route calls window.__canvasPrintFit()
  // directly because headless printToPDF fires neither event.
  const exportPrintScript =
    mode === "export" ? `<script>\n${EXPORT_PRINT_JS}\n</script>` : "";

  // Standalone letterbox fit. Kit decks scale slides with
  // `.slide { zoom: var(--slide-zoom) }`, and their nav.js sets
  // --slide-zoom = innerWidth/1920 — WIDTH-fit only. Opened in a window
  // shorter than the 16:9 design (the common maximized-browser case), the
  // slide overflows and body{overflow:hidden} crops the bottom of every slide.
  // In export mode we inject a screen-only letterbox that fits BOTH axes and
  // sizes .deck to exactly one rendered slide, centered, so nothing crops and
  // the neighbor in the strip can't bleed in. See EXPORT_FIT_CSS/JS.
  //
  // Gated to zoom-scaled carousels — decks that use --slide-zoom themselves
  // (the kit) plus fixed-px decks the zoom shim below scales the same way. Not
  // viewport-unit or vertical-stack decks: their slides already fill the
  // viewport, and fitting a vertical-scroll deck would wrongly shrink it.
  // Screen-only, so the print / PDF path (EXPORT_PRINT_CSS) is untouched.
  const usesSlideZoom =
    /--slide-zoom/.test(input.theme_css) || /--slide-zoom/.test(input.nav_js);
  // Fixed-px deck with no scaling of its own → the shim scales it (see
  // viewportShimZoomCss). Kit decks keep the squeeze shim they co-evolved with.
  const shimNeeded = needsViewportShim(input.theme_css);
  const shimSize =
    shimNeeded && !usesSlideZoom ? detectFixedSlideSize(input.theme_css) : null;
  const zoomScaled = usesSlideZoom || shimSize != null;
  const exportFitStyle =
    mode === "export" && zoomScaled
      ? `<style data-canvas="export-fit">\n${EXPORT_FIT_CSS}\n</style>`
      : "";
  const exportFitScript =
    mode === "export" && zoomScaled
      ? `<script>\n${EXPORT_FIT_JS}\n</script>`
      : "";

  // When the caller asks to hide the click-to-edit hint (proposal previews),
  // emit a tiny <style> in <head> that wins over any theme_css rule the
  // source HTML ships. We use `!important` + `display:none` on `.hint`,
  // `#hint`, and any `::before`/`::after` content attached to those, since
  // hints in real-world decks are sometimes painted via CSS content rather
  // than the empty stub DOM we inject. The hint stub itself is also dropped
  // from the body so deck nav.js writing `textContent` into it becomes a
  // null-coalesced no-op.
  const hintSuppressStyle = input.suppressEditHint
    ? `<style data-canvas="suppress-edit-hint">
.hint, #hint { display: none !important; visibility: hidden !important; }
.hint::before, .hint::after, #hint::before, #hint::after { content: none !important; display: none !important; }
</style>`
    : "";
  const hintStub = input.suppressEditHint
    ? ""
    : `<div class="hint" id="hint"></div>`;

  // Auto-rebind fixed-pixel / wrapper-dependent decks (standalone exports,
  // PPTX conversions) onto Canvas's `.deck > #slides > .slide` viewport-unit
  // model so they scale to the iframe instead of rendering blank. No-op for
  // Canvas-native decks (and for blank-template decks, which the controller
  // already drives as a vertical scroll stack). Applies in both modes — a
  // standalone export of a fixed-px deck is broken the same way the preview is.
  // Placed after theme_css below so it wins the cascade; the print stylesheet
  // (export) still overrides it inside paged media for one-slide-per-page PDF.
  //
  // Two variants: decks that scale themselves (--slide-zoom, i.e. the kit) get
  // the classic 100vw squeeze their embedded rules expect; fixed-px decks with
  // no scaling get the zoom shim + width-fit driver so their px content shrinks
  // to the viewport instead of wrapping/cropping (see viewportShimZoomCss).
  const viewportShimStyle = shimNeeded
    ? `<style data-canvas="viewport-shim">\n${
        shimSize ? viewportShimZoomCss(shimSize) : VIEWPORT_SHIM_CSS
      }\n</style>`
    : "";
  const viewportShimZoomScript = shimSize
    ? `<script data-canvas="viewport-shim-zoom">\n${viewportShimZoomJs(shimSize.width)}\n</script>`
    : "";

  // Re-inject the deck's non-slide body chrome (modal overlays, dots rails —
  // see parser.extractChromeHtml) so nav_js interactivity handlers
  // (`onclick="openModal('d1')"`) find the DOM they address by id instead of
  // crashing on null. Injected in BOTH modes — an exported standalone file
  // needs its modals as much as the preview does. Deck-native *navigation*
  // chrome inside the wrapper (.navbar/.arrows/.dots and the editor hint) is
  // CSS-hidden: the host React chrome (preview) / EXPORT_CHROME (export) owns
  // navigation, and the deck's own rails would render as duplicate, often
  // broken controls. Hidden — not dropped — so getElementById bindings in
  // nav_js still resolve.
  const chromeHtml =
    typeof input.meta?.chrome_html === "string"
      ? (input.meta.chrome_html as string).trim()
      : "";
  const deckChromeMarkup = chromeHtml
    ? `<div data-canvas="deck-chrome">\n${stripContenteditable(chromeHtml)}\n</div>`
    : "";
  const deckChromeStyle = chromeHtml
    ? `<style data-canvas="deck-chrome">
[data-canvas="deck-chrome"] .navbar, [data-canvas="deck-chrome"] .arrows,
[data-canvas="deck-chrome"] .dots, [data-canvas="deck-chrome"] .hint,
[data-canvas="deck-chrome"] #hint { display: none !important; }
</style>`
    : "";

  // Re-emit preserved web-font <link rel="stylesheet"> hrefs (see
  // parser.extractFontLinks → meta.font_links) so an imported deck keeps its
  // fonts in Canvas. Emitted in BOTH modes: preview needs the live network
  // stylesheet to render the right font; export emits them too, and the export
  // route's font inliner (export-assets.ts) then rewrites these same links into
  // an inline @font-face <style> so the downloaded file is self-contained. The
  // hrefs were allowlisted to known font hosts at import time; we re-escape on
  // the way out so a quote in a query string can't break out of the attribute.
  const fontLinks = Array.isArray(input.meta?.font_links)
    ? (input.meta.font_links as unknown[]).filter(
        (h): h is string => typeof h === "string" && h.length > 0,
      )
    : [];
  const fontLinkTags = fontLinks
    .map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`)
    .join("\n  ");

  // Preview mode: silence the deck's global keyboard / touch handlers BEFORE
  // its nav.js runs. See the EMBEDDED_GUARD docstring for why. Export mode
  // skips the guard because the standalone deck file is the only thing
  // driving navigation — its keyboard handler is essential.
  const embeddedGuardScript =
    mode === "preview" ? `<script>\n${EMBEDDED_GUARD}\n  </script>` : "";

  // Preview mode: inject the inline direct-edit controller. Inert until the
  // host posts `canvas:edit-start` — it adds no behaviour to a normal preview.
  // Never injected in export mode (the standalone file has no host to drive
  // editing, and its slide HTML must stay read-only). See CANVAS_EDITOR.
  const editorScript =
    mode === "preview" ? `<script>\n${CANVAS_EDITOR}\n  </script>` : "";

  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="${escapeAttr(viewport)}">
  <title>${escapeHtml(input.title)}</title>
  ${fontLinkTags}
  <style>
${input.theme_css}
${slideStyles}
  </style>
  ${viewportShimStyle}
  ${deckChromeStyle}
  ${exportChromeStyle}
  ${exportPrintStyle}
  ${exportFitStyle}
  ${hintSuppressStyle}
</head>
<body>
  <div class="deck">
    ${hintStub}
    <div id="slides" class="slides">
${body}
    </div>
    ${navChrome}
  </div>
  ${deckChromeMarkup}
  ${exportChromeMarkup}
  ${viewportShimZoomScript}
  ${embeddedGuardScript}
  <script>
${input.nav_js}
  </script>
  ${standaloneFlagScript}
  <script>
${CANVAS_CONTROLLER}
  </script>
  ${editorScript}
  ${exportChromeScript}
  ${exportPrintScript}
  ${exportFitScript}
</body>
</html>`;
}

/**
 * Inject `data-canvas-position` onto the slide's outer `<section>` tag. If
 * the html_body doesn't start with a section (unlikely — parser wraps it) we
 * fall back to wrapping in a `<div>`.
 */
function tagSection(html: string, position: number): string {
  const match = html.match(/^\s*<section\b((?:"[^"]*"|'[^']*'|[^>])*)>/i);
  if (match) {
    const attrs = match[1] ?? "";
    const replacement = `<section${attrs} data-canvas-position="${position}">`;
    return html.replace(match[0], replacement);
  }
  return `<div data-canvas-position="${position}">${html}</div>`;
}

/**
 * Hidden DOM stubs that the deck's own nav.js expects to find via
 * `getElementById`. Previously these were the visible nav chrome and
 * depended on the deck's theme_css to style `.navbar`, `.left`, `.right`,
 * etc. — which silently broke for any deck (blank-template or imported)
 * whose theme didn't ship those rules.
 *
 * The visible chrome now lives in the host (`deck-chrome.tsx`), driven by
 * the `canvas:state` / `canvas:navigate` postMessage protocol. The stubs
 * stay for two reasons:
 *   1. Older deck nav scripts bind to `#prevBtn` / `#nextBtn` / `#current`
 *      / `#dotsNav` via `getElementById` at script-load time — without
 *      stubs they'd throw, taking the deck preview down.
 *   2. `CANVAS_CONTROLLER.navigate()` writes through them on every move
 *      (toggling `.active` on the dots, updating `#current` text,
 *      disabling prev/next). That state survives the round-trip via
 *      `canvas:state` so the host chrome stays consistent even when the
 *      iframe is hot-swapped (e.g. previewKey bump after an edit).
 *
 * `display:none` is inline so deck theme CSS can't accidentally re-show
 * the stubs (no `.navbar { display: flex !important }` regressions).
 */
function navChromeHtml(slideCount: number): string {
  return `<div class="navbar" aria-hidden="true" style="display:none !important">
      <div class="left">
        <button class="nav-btn" id="prevBtn" aria-label="Previous">←</button>
        <span class="nav-label">Previous</span>
      </div>
      <div class="dots-nav" id="dotsNav"></div>
      <div class="right">
        <span class="counter"><strong id="current">1</strong> / <span id="total">${slideCount}</span></span>
        <span class="nav-label">Next</span>
        <button class="nav-btn" id="nextBtn" aria-label="Next">→</button>
      </div>
    </div>`;
}

/**
 * Make slide HTML truly read-only for the preview + export by removing every
 * `contenteditable` attribute. The seed Claude decks sprinkle these
 * everywhere with an in-iframe localStorage auto-save, which means a
 * teammate clicking a heading in our preview to "fix a typo" would feel like
 * they edited the deck but their work would never reach Postgres — and a
 * peer opening the same deck wouldn't see it. Stripping the attribute makes
 * the affordance match reality: edits happen via Claude Code through MCP.
 *
 * The DB row keeps the original markup, so this is purely a render-time
 * scrub; we can drop the function later if we want to wire up inline editing.
 */
function stripContenteditable(html: string): string {
  return html.replace(/\s+contenteditable\s*=\s*("[^"]*"|'[^']*'|true|false)/gi, "");
}

/**
 * Pre-script injected before the deck's nav.js in preview mode.
 *
 * Why this exists: deck nav.js scripts (which are arbitrary JS uploaded with
 * each deck) wire two globally-scoped handlers that fight the host:
 *   - `document.addEventListener('keydown', ...)` for ArrowLeft/Right etc.
 *   - `slidesEl.addEventListener('touchstart'/'touchend', ...)` for swipe
 * Both call the deck's internal `goTo(i)`, which writes
 * `slidesEl.style.transform = translateX(-i*100vw)` directly. When Canvas
 * is the host, the host also owns keyboard nav (deck-workspace's window
 * onKey) and the controller writes the same transform through
 * `CANVAS_CONTROLLER.navigate()`. Three drivers racing for the same DOM
 * state caused the back-and-forth slide jumps a user reported.
 *
 * The guard silences the deck's two global handlers WITHOUT touching
 * anything else:
 *   - Wraps `document.addEventListener` to drop registrations for
 *     `keydown` / `keyup` / `keypress`.
 *   - Wraps `Element.prototype.addEventListener` to drop registrations for
 *     `touch*` events ONLY when the element is `#slides`. Per-element
 *     keydown handlers (e.g. the dores modal's `.dot` keyboard activation)
 *     and per-element click handlers (modal close, dot click) survive.
 *
 * Export mode skips this guard: the standalone deck file has no host, and
 * the deck's keyboard handler is the only way the user can move slides
 * with the keyboard.
 */
const EMBEDDED_GUARD = `
(function () {
  var KEY = { keydown: 1, keyup: 1, keypress: 1 };
  var TOUCH = { touchstart: 1, touchend: 1, touchmove: 1 };
  var origDocAdd = document.addEventListener;
  document.addEventListener = function (type, listener, options) {
    if (KEY[type]) return;
    return origDocAdd.call(this, type, listener, options);
  };
  var origElAdd = Element.prototype.addEventListener;
  Element.prototype.addEventListener = function (type, listener, options) {
    if (TOUCH[type] && this && this.id === 'slides') return;
    return origElAdd.call(this, type, listener, options);
  };
  window.__canvasEmbedded = true;
})();
`.trim();

/**
 * Inline script that runs inside the iframe. Kept short and dependency-free.
 * Communicates with the parent via `window.postMessage`.
 *
 * Host → iframe:
 *   canvas:navigate { position }       — show slide N
 *   canvas:request-bounds [{position}] — reply with bounds now
 *   canvas:request-state [{position}]  — reply with state now
 *
 * Iframe → host:
 *   canvas:slide-bounds { position,    — emitted on load, on resize, after
 *     rect: {x, y, w, h},                navigate, and on explicit request.
 *     viewport: {w, h} }                 `rect` is the active slide's
 *                                        getBoundingClientRect in iframe-
 *                                        viewport pixels; the host overlays
 *                                        comment pins by positioning at
 *                                        (x + ax*w, y + ay*h).
 *   canvas:state { position, total }   — emitted alongside bounds. Authoritative
 *                                        for the host chrome's Previous/Next/
 *                                        counter/dots in preview mode.
 *
 * Navigation: `navigate(target)` writes the carousel state directly —
 * `#slides`'s transform, dot `.active` classes, `#current` text, prev/next
 * disabled — rather than dispatching events or clicking hidden dots. The
 * old click + KeyboardEvent dispatch path raced with both the host's
 * `window` onKey listener and the deck's own `document` keydown listener
 * (silenced by EMBEDDED_GUARD in preview mode), producing the slide
 * back-and-forth. Direct DOM writes are deterministic and don't depend on
 * any of the deck's listeners firing.
 */
const CANVAS_CONTROLLER = `
(function () {
  var lastPosition = 0;

  // The ordered set of slide elements. Decks assembled here always tag each
  // <section> with data-canvas-position in sorted order; the section.slide
  // branch only covers decks that predate the tag.
  function orderedSlides() {
    var tagged = document.querySelectorAll('[data-canvas-position]');
    if (tagged && tagged.length) return tagged;
    return document.querySelectorAll('section.slide');
  }

  function findSlideElement(position) {
    var sec = document.querySelector('[data-canvas-position="' + position + '"]');
    if (sec) return sec;
    var fallbacks = orderedSlides();
    return fallbacks[position] || null;
  }

  function totalSlides() {
    return orderedSlides().length || 1;
  }

  // A slide's INDEX (0-based, display order) from its element. Decks carry
  // SPARSE positions (0,1,2,3,5,7,…) once slides are inserted or deleted, so a
  // position is NOT an index. navigate() resolves the element by position and
  // maps to this index for every index-based bit of layout math below.
  function indexOfSlide(sec) {
    var secs = orderedSlides();
    for (var i = 0; i < secs.length; i++) { if (secs[i] === sec) return i; }
    return -1;
  }

  // Is \`#slides\` actually a horizontal carousel (slides laid out side by
  // side), or just a vertical stack? Real-world carousel decks ship a flex strip whose
  // nav.js translates it by -i*100vw; blank / create_deck decks (minimal
  // theme, empty nav.js) stack their slides vertically with no strip. We tell
  // them apart by measuring: in a horizontal strip the second slide's
  // offsetLeft sits to the right of the first's. offsetLeft ignores CSS
  // transforms (unlike getBoundingClientRect), so a translateX a prior
  // navigate() already applied can't skew the reading. Driving a vertical
  // stack with translateX(-N*100vw) shoves the whole column sideways
  // off-screen, so every slide past the first renders blank — exactly the bug
  // this guards against.
  function isHorizontalStrip(slidesEl) {
    var secs = slidesEl.querySelectorAll('[data-canvas-position]');
    if (secs.length < 2) return true;
    return secs[1].offsetLeft > secs[0].offsetLeft + 1;
  }

  function safePost(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (err) { /* parent gone */ }
  }

  function postBounds(position) {
    var pos = typeof position === 'number' ? position : lastPosition;
    var el = findSlideElement(pos);
    var msg = {
      type: 'canvas:slide-bounds',
      position: pos,
      viewport: {
        w: document.documentElement.clientWidth || window.innerWidth || 0,
        h: document.documentElement.clientHeight || window.innerHeight || 0,
      },
      rect: null,
    };
    if (el && typeof el.getBoundingClientRect === 'function') {
      var r = el.getBoundingClientRect();
      msg.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    safePost(msg);
  }

  function postState(position) {
    var pos = typeof position === 'number' ? position : lastPosition;
    safePost({ type: 'canvas:state', position: pos, total: totalSlides() });
  }

  // Direct DOM navigation. The deck's own keyboard / touch handlers are
  // silenced by EMBEDDED_GUARD before nav.js runs, and clicking hidden
  // dots / dispatching synthetic key events both raced with the host's
  // listeners. Here we just write the carousel state straight through —
  // \`#slides\` transform, dot \`.active\` flags, \`#current\` counter,
  // prev/next disabled. Decks laid out as a vertical stack (no horizontal
  // flex strip) are driven by scrollIntoView instead — see isHorizontalStrip.
  function navigate(target) {
    if (typeof target !== 'number' || !Number.isFinite(target)) return;
    target = Math.max(0, Math.floor(target));
    var total = totalSlides();

    // \`target\` is a slide's DB position (sparse), NOT an index. Resolve the
    // element by position, then derive its display index — driving the clamp,
    // translateX, dot and counter math off the position directly sent any slide
    // whose position >= slide count to the wrong slide on gapped decks (click
    // the last slide, watch it bounce to an earlier one). Bail on an unknown
    // position rather than clamping it into a different slide. \`lastPosition\`
    // stays the position so the canvas:state we broadcast back still matches
    // the host's selection (which keys on position, not index).
    var sec = findSlideElement(target);
    if (!sec) return;
    var index = indexOfSlide(sec);
    if (index < 0) index = 0;
    lastPosition = target;

    var slidesEl = document.getElementById('slides');
    if (slidesEl) {
      // SNAP, don't animate. Kit decks ship \`transition: transform .35s\` on the
      // strip. In standalone use that animates a single user-driven slide change
      // — fine. But here the HOST owns navigation and re-asserts the SAME target
      // several times during auto-entry (host mount + window 'load' + load+300ms +
      // observeStripLayout's ResizeObserver), each racing the kit's deferred
      // setZoom (--slide-zoom applied at load, +200ms, +800ms). With the transition
      // live, those overlapping re-asserts interrupt each other's 0.35s tween and
      // the strip strands mid-animation at a stale offset — the slide never reaches
      // its mark and the preview reads blank until a manual Refresh fires one last
      // navigate after everything has settled. Forcing transition:none makes every
      // programmatic assert land instantly and idempotently, so the LAST one always
      // wins regardless of ordering. Inline beats the deck's non-important rule.
      slidesEl.style.transition = 'none';
    }
    if (slidesEl && isHorizontalStrip(slidesEl)) {
      // Translate by the slide's RENDERED layout offset, not index*100vw and not
      // raw offsetLeft. Kit decks lay slides out at a fixed design width (1920px)
      // and scale each one with CSS \`zoom\` (--slide-zoom = innerWidth/1920) to fit
      // the preview. CSS zoom is the trap: it shrinks a slide's RENDERED width to
      // 1920*zoom, but Chrome still reports \`offsetLeft\` in UNZOOMED layout px
      // (index*1920). Translating by raw offsetLeft over-shoots by 1/zoom — ask for
      // slide 8 and land on ~slide 14, or past the end (blank). The kit's own nav
      // uses index*100vw, which only works because one zoomed slide == 100vw; our
      // controller must arrive at the same place. Convert layout offset → rendered
      // px with the slide's own render/layout ratio (getBoundingClientRect().width
      // / offsetWidth): for a zoomed kit slide that's ~0.574, for an unscaled /
      // native-100vw deck it's 1 (so raw offsetLeft — the previous behaviour — is
      // just the scale==1 case, and fixed-width-no-zoom decks are unaffected). Fall
      // back to index*100vw only when the rendered offset is 0 for a non-first
      // slide (layout not yet measured) so we never emit a worse value than before;
      // observeStripLayout() re-asserts once zoom + layout settle.
      var off = sec.offsetLeft;
      var ow = sec.offsetWidth || 0;
      var rw =
        typeof sec.getBoundingClientRect === 'function'
          ? sec.getBoundingClientRect().width
          : 0;
      var scale = ow > 0 && rw > 0 ? rw / ow : 1;
      var px = off * scale;
      if (px > 0 || index === 0) {
        slidesEl.style.transform = 'translateX(-' + px + 'px)';
      } else {
        slidesEl.style.transform = 'translateX(-' + (index * 100) + 'vw)';
      }
    } else {
      // Vertical-stack deck (no horizontal strip) — clear any stale transform
      // a prior horizontal navigate left behind, then scroll the target slide
      // into view. Covers blank-template decks whose theme never sets up a
      // carousel as well as plain vertical-scroll decks with no \`#slides\`.
      if (slidesEl) slidesEl.style.transform = '';
      if (typeof sec.scrollIntoView === 'function') {
        sec.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    }
    var currentEl = document.getElementById('current');
    if (currentEl) currentEl.textContent = String(index + 1);
    var dots = document.querySelectorAll('#dotsNav .dot-nav, #dotsNav button');
    if (dots && dots.length) {
      for (var i = 0; i < dots.length; i++) {
        if (i === index) dots[i].classList.add('active');
        else dots[i].classList.remove('active');
      }
    }
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    if (prevBtn) prevBtn.disabled = index === 0;
    if (nextBtn) nextBtn.disabled = index === total - 1;

    scheduleBounds(target);
  }

  // Decks animate between slides; broadcasting bounds immediately catches the
  // outgoing slide's rect. A short rAF chain lets the layout settle before we
  // measure. Three frames covers most transitions (~50ms) without blocking.
  // State piggybacks on the same schedule — position/total are cheap and
  // host chrome wants them in lockstep with bounds anyway. A generation
  // counter cancels in-flight callbacks when a newer schedule supersedes
  // them, so a stale 600ms broadcast can't overwrite the host's current
  // selection during rapid navigation.
  // Bumped on every call; stale callbacks short-circuit on mismatch.
  var scheduleGen = 0;
  function scheduleBounds(position) {
    scheduleGen++;
    var myGen = scheduleGen;
    var ticks = 0;
    function tick() {
      if (myGen !== scheduleGen) return;
      postBounds(position);
      postState(position);
      ticks++;
      if (ticks < 3) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    setTimeout(function () {
      if (myGen !== scheduleGen) return;
      postBounds(position); postState(position);
    }, 250);
    setTimeout(function () {
      if (myGen !== scheduleGen) return;
      postBounds(position); postState(position);
    }, 600);
  }

  window.addEventListener('message', function (e) {
    var data = e && e.data;
    if (!data) return;
    if (data.type === 'canvas:navigate') {
      navigate(data.position);
    } else if (data.type === 'canvas:request-bounds') {
      postBounds(typeof data.position === 'number' ? data.position : undefined);
    } else if (data.type === 'canvas:request-state') {
      postState(typeof data.position === 'number' ? data.position : undefined);
    }
  });

  window.addEventListener('resize', function () { postBounds(); });
  // On load, RE-ASSERT the scroll (navigate), not just re-emit bounds
  // (scheduleBounds). A vertical-stack / doc-heavy deck settles its layout —
  // web-font swap, late reflow — AFTER the load event, which strands the host's
  // initial canvas:navigate scrollIntoView at a now-stale offset: the target
  // slide drifts up so the tail of the previous slide shows above it ("two
  // slides stacked on page 1"). navigate() re-runs the scroll; scheduleBounds()
  // only re-posts the position. navigate(lastPosition) always re-asserts the
  // CURRENT target (the host updates lastPosition via canvas:navigate), so this
  // can't revert a user who arrow-keyed within the window. The deferred second
  // pass catches reflow that lands a frame or two after load (late font swaps).
  window.addEventListener('load', function () {
    navigate(lastPosition);
    setTimeout(function () { navigate(lastPosition); }, 300);
  });

  // The deck's own keydown handler is silenced by EMBEDDED_GUARD, so without
  // a forwarder a user who clicked into a slide (focusing the iframe) would
  // get no response from arrow keys. Bind on the iframe's \`window\` (not
  // \`document\`, which EMBEDDED_GUARD wrapped) and post the key up to the
  // host, which already owns the navigation policy (edit-surface checks,
  // modal interlocks). The host responds by updating its selection and
  // round-tripping a \`canvas:navigate\`. preventDefault on Space stops the
  // iframe from scrolling under us.
  var FORWARD_KEYS = { ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, ' ': 1 };

  // Standalone = the exported .html opened directly, with no Canvas host. Set
  // by assemble.ts's export-mode flag script that runs before this controller.
  // In that case there is no parent to forward keys to and no host to round-
  // trip a canvas:navigate, so the controller drives the carousel itself.
  function isStandalone() { return window.__canvasStandalone === true; }

  // Standalone keyboard nav: map the key to a target INDEX, convert to that
  // slide's (possibly sparse) position, and drive navigate() — the exact same
  // transform / zoom / vertical-stack logic the host uses over postMessage. In
  // the Canvas host this path is never taken; the key is forwarded up and the
  // host round-trips a canvas:navigate.
  function navigateByKey(key) {
    var secs = orderedSlides();
    var total = secs.length;
    if (!total) return;
    var curEl = findSlideElement(lastPosition);
    var idx = curEl ? indexOfSlide(curEl) : 0;
    if (idx < 0) idx = 0;
    var next = idx;
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') next = idx + 1;
    else if (key === 'ArrowLeft' || key === 'PageUp') next = idx - 1;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = total - 1;
    if (next < 0) next = 0;
    if (next > total - 1) next = total - 1;
    if (next === idx) return;
    var target = secs[next];
    if (!target) return;
    var pos = target.getAttribute && target.getAttribute('data-canvas-position');
    navigate(pos !== null && pos !== undefined && pos !== '' ? parseInt(pos, 10) : next);
  }

  window.addEventListener('keydown', function (e) {
    if (!e || !FORWARD_KEYS[e.key]) return;
    if (e.target && (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (isStandalone()) navigateByKey(e.key);
    else safePost({ type: 'canvas:key', key: e.key });
  });

  // Forward pointer/touch activity to the host. A presenter view auto-hides
  // its chrome + cursor on idle and reveals them on activity — but the host
  // can't observe mousemove over this cross-origin iframe directly, so the
  // iframe (which sees its own pointer events) posts a throttled signal up.
  // Hosts that don't present (the editor preview) simply ignore the message.
  var activityThrottled = false;
  function forwardActivity() {
    if (activityThrottled) return;
    activityThrottled = true;
    setTimeout(function () { activityThrottled = false; }, 200);
    safePost({ type: 'canvas:activity' });
  }
  window.addEventListener('mousemove', forwardActivity, { passive: true });
  window.addEventListener('touchstart', forwardActivity, { passive: true });

  // Re-assert navigation the moment the strip actually lays out. On AUTO-ENTRY
  // the host posts canvas:navigate (and our window 'load' handler re-asserts)
  // while the flex strip is still unmeasured — every slide reports offsetLeft 0
  // (pre-layout, pre-font-swap). At that point navigate() can't place the target:
  // isHorizontalStrip() reads false (0 > 0+1 is false) so a real carousel is
  // mistaken for a vertical stack, or the offsetLeft path falls back to
  // index*100vw and strands a fixed-width kit slide off-screen. Either way the
  // preview is blank until a manual Refresh. The fixed load+300ms re-assert isn't
  // long enough for heavier decks. Rather than guess a longer timeout, OBSERVE the
  // layout: a ResizeObserver on the slide sections fires when their boxes first
  // gain size (and again on a late font-swap reflow), at which point we re-run
  // navigate(lastPosition) with REAL offsets. Deduped on the target slide's
  // offsetLeft so a burst of layout callbacks re-asserts exactly once per geometry
  // change. navigate(lastPosition) only ever re-applies the CURRENT target (the
  // host updates lastPosition via canvas:navigate), so a late reflow can never
  // revert a user who navigated within the window — same invariant the 'load'
  // handler relies on. No-op where ResizeObserver is unavailable: the load+300ms
  // re-assert stays as the fallback, so this is purely additive.
  function observeStripLayout() {
    var slidesEl = document.getElementById('slides');
    if (!slidesEl) return;
    var secs = slidesEl.querySelectorAll('[data-canvas-position]');
    if (secs.length < 2) return; // single slide / no strip — nothing to measure

    // One deduped re-assert, driven by every "the geometry moved" signal below.
    // Signature = offsetLeft (layout position) + rendered width. Rendered width is
    // what a CSS-zoom settle moves, and it does NOT change offsetLeft, so keying
    // on offsetLeft alone would miss exactly the reflow we must catch. Snap
    // navigation (transition:none in navigate) makes every pass idempotent, so a
    // burst of signals re-asserts at most once per real geometry change.
    var lastSig = '';
    function reassert() {
      var sec = findSlideElement(lastPosition);
      if (!sec) return;
      var rw =
        typeof sec.getBoundingClientRect === 'function'
          ? Math.round(sec.getBoundingClientRect().width)
          : 0;
      var sig = sec.offsetLeft + ':' + rw;
      if (sig === lastSig) return; // geometry unchanged — nothing to re-assert
      lastSig = sig;
      navigate(lastPosition);
    }

    // (1) Layout reflow — initial measure, font swap, window resize.
    try {
      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(reassert);
        ro.observe(slidesEl);
        for (var i = 0; i < secs.length; i++) ro.observe(secs[i]);
      }
    } catch (e) { /* no ResizeObserver / non-DOM env */ }

    // (2) CSS zoom settle — the real auto-entry blank. Kit decks fit their fixed
    // 1920px slides by setting --slide-zoom on <html> on a DEFERRED schedule
    // (load, +200ms, +800ms). CSS \`zoom\` shrinks the rendered offset but, unlike
    // a width change, does NOT fire ResizeObserver — so (1) never sees it and the
    // strip stays at its pre-zoom (over-translated) offset: the slide renders
    // blank until a manual Refresh. Every setZoom mutates <html>'s style attribute,
    // so a MutationObserver on it catches the settle precisely and re-asserts with
    // the now-correct scale.
    try {
      if (typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(reassert);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      }
    } catch (e) { /* no MutationObserver / non-DOM env */ }

    // (3) Safety sweep — covers a zoom applied before the observers attached, or
    // an environment missing them. Bounded and deduped, so it's a near-no-op once
    // the strip is stable; the 1100ms pass sits past the kit's last setZoom (800ms).
    [120, 360, 700, 1100].forEach(function (ms) { setTimeout(reassert, ms); });
  }
  observeStripLayout();

  // Exposed for the standalone export chrome (export-chrome.ts): its buttons
  // and dots call this to move the carousel through the exact logic the host
  // drives over postMessage, instead of duplicating the transform / zoom math.
  // Takes a slide POSITION (the value data-canvas-position holds), same as the
  // canvas:navigate message. Harmless in preview — nothing there calls it.
  window.__canvasNavigate = navigate;

  // First broadcast — the iframe's onLoad fires before our script runs on
  // initial parse, so emit synchronously too.
  scheduleBounds(0);
})();
`.trim();

/**
 * Inline direct-edit controller, injected (preview mode only) after
 * CANVAS_CONTROLLER. Inert until the host posts `canvas:edit-start` — a normal
 * preview behaves exactly as before.
 *
 * Why it lives inside the iframe: the preview is served with CSP
 * `sandbox allow-scripts` and NO `allow-same-origin` (see the preview route),
 * so the host React app cannot reach into `iframe.contentDocument`. The only
 * way edited HTML gets back out is the same postMessage channel the navigation
 * controller already uses.
 *
 * Protocol:
 *   Host -> iframe:
 *     canvas:edit-start  { position }  — make that slide's <section> editable
 *     canvas:edit-cancel               — drop editability (host remounts to
 *                                         discard the in-place changes)
 *     canvas:edit-save   { position }  — serialize + post the slide HTML up
 *   iframe -> host:
 *     canvas:edit-ready  { position, ok } — confirms the slide was found
 *     canvas:slide-html  { position, html } — the edited <section> HTML, cleaned
 *
 * Editing model: the whole active <section> is set `contenteditable`, so a user
 * edits the text exactly where it renders. Structural/layout changes are out of
 * scope (that's the host's "edit code" fallback); this is for fixing the text
 * that already exists. On save we serialize a CLONE and undo the render-time
 * mutations so the stored html_body matches the propose/MCP shape:
 *   - drop `data-canvas-position` (assemble injected it via tagSection)
 *   - drop the `contenteditable` / `spellcheck` attrs we added (incl. any the
 *     browser sprinkled onto descendants)
 *   - de-sign asset URLs: `/api/canvas/asset/<uuid>?<sig>` -> bare path (the
 *     preview route signs these per-request; the signature must never persist)
 *
 * Element pick mode (the "point at it" half of element-anchored prompts):
 *   Host -> iframe:
 *     canvas:pick-start  { position }  — hover-highlight elements inside that
 *                                         slide's <section>; click selects
 *     canvas:pick-cancel               — leave pick mode (host also maps Esc)
 *   iframe -> host:
 *     canvas:element-picked { position, html, descriptor, rect } — the clicked
 *       element's cleaned outerHTML (same serialization rules as edit-save)
 *       plus a short human label ("div.gantt-block") and its viewport-relative
 *       bounding rect (the host iframe fills its wrapper 1:1, so the host uses
 *       it to anchor the "prompt copied" popover on the element itself). The
 *       host wraps the HTML into a patch-biased prompt for Claude.
 *
 * Inspect mode (the direct-manipulation inspector — ranked fix #1):
 *   Host -> iframe:
 *     canvas:inspect-start  { position } — pick-style hover highlight; click
 *                                          SELECTS an element (persistent
 *                                          outline) instead of posting HTML
 *     canvas:inspect-set    { styles }   — write inline styles onto the
 *                                          selected element (allowlisted CSS
 *                                          props; null/'' removes the prop)
 *     canvas:inspect-nudge  { dx, dy }   — move the selected element by px:
 *                                          left/top when absolutely
 *                                          positioned, margins in flow
 *     canvas:inspect-parent              — reselect the parent element
 *     canvas:inspect-deselect            — clear the selection (keep mode)
 *     canvas:inspect-text   { }          — begin in-place TEXT editing of the
 *                                          selected element (same as a
 *                                          double-click inside the iframe). The
 *                                          element goes contenteditable + focus;
 *                                          Enter / Escape / blur / clicking
 *                                          another element commit it. A typo no
 *                                          longer forces a trip out to raw HTML.
 *     canvas:inspect-save   { position } — serialize + post canvas:slide-html
 *                                          (same reply as edit-save, so the
 *                                          host's direct-save path is reused).
 *                                          Auto-commits any open text edit first
 *                                          so the typed text is in the DOM it
 *                                          serializes.
 *     canvas:inspect-cancel              — leave inspect mode (host remounts
 *                                          to discard the in-place changes)
 *   iframe -> host:
 *     canvas:inspect-ready    { position, ok }
 *     canvas:element-selected { position, descriptor, styles } — posted on
 *       every (re)selection; styles is a computed snapshot (font size, color,
 *       background, alignment, padding, width, height…) the host inspector
 *       initializes its controls from. Also re-posted after a handle resize
 *       so the panel's size fields track the new box.
 *     canvas:inspect-text-state { position, editing } — posted when text
 *       editing of the selection STARTS (editing:true) and COMMITS
 *       (editing:false), so the host can flip its inspector hint between
 *       "editing text" and the style controls. Text mutations stay in-DOM
 *       (live <section>) until inspect-save serializes them — no separate
 *       text payload travels back; the slide HTML is the single source.
 *     canvas:inspect-deselected — selection cleared (Esc inside the iframe)
 *
 *   Arrow keys nudge the selected element INSIDE the iframe (Shift = 10px),
 *   captured before the controller's canvas:key forwarder so nudging never
 *   pages slides. While text editing, arrows/Enter are left to the browser's
 *   caret so typing works. All changes stay in-DOM until inspect-save; the host
 *   discards by remounting the iframe, exactly like visual edit.
 *
 *   A selection also grows 8 resize grips (body-level fixed layer, rAF-synced
 *   to the element's rect — never serialized). Dragging a grip writes inline
 *   width/height, clamped to the slide and a minimum size (cvResizeClamp);
 *   west/north grips keep the opposite edge anchored via left/top (absolute)
 *   or the managed translate (flow). Shift on a corner locks the aspect ratio.
 */
const CANVAS_EDITOR = `
(function () {
${DRAG_GEOMETRY_JS}
  var editing = null; // { section: Element, position: number }
  var picking = null; // { section: Element, position: number, hovered: Element|null }
  var inspecting = null; // { section: Element, position: number, hovered: Element|null, selected: Element|null }
  var textEditing = null; // { el: Element } while an inspected element's text is being typed in place
  var dragging = null; // active pointer gesture: move OR resize (handle != null)
  var tfState = new WeakMap(); // el -> { base, tx, ty }: translate-based flow moves
  var handleLayer = null; // fixed-position layer holding the 8 resize handles
  var handleRaf = 0; // rAF id of the handle-sync loop (runs while a selection exists)
  var suppressClick = false; // swallow the click trailing a pointer gesture (we select on pointerdown)
  var ASSET_SIG_RE = /(\\/api\\/canvas\\/asset\\/[0-9a-fA-F-]{36})\\?[^"'\\s)]*/g;
  var styleInjected = false;

  function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var st = document.createElement('style');
    st.setAttribute('data-canvas', 'editor');
    st.textContent = '[data-canvas-editing="true"]{outline:2px dashed rgba(200,112,42,0.9);outline-offset:-2px;cursor:text;}[data-canvas-editing="true"] *::selection{background:rgba(200,112,42,0.25);}'
      + '[data-canvas-picking="true"], [data-canvas-picking="true"] *{cursor:crosshair !important;}'
      + '[data-canvas-pick-hover="true"]{outline:2px solid rgba(59,130,246,0.95) !important;outline-offset:-2px;background:rgba(59,130,246,0.08) !important;}'
      // Inspector selection — copper (the edit accent), persistent until
      // deselect. Hover reuses the pick-hover blue above. The selection shows a
      // move cursor (it's draggable); during a drag the whole document grabs.
      + '[data-canvas-inspect-selected="true"]{outline:2px solid rgba(200,112,42,0.95) !important;outline-offset:-2px;cursor:move;}'
      // Text-edit mode: a dashed copper outline + text caret + live selection
      // tint, matching the visual-edit affordance so "I'm typing here now" reads
      // the same in both editors.
      + '[data-canvas-text-editing="true"]{outline:2px dashed rgba(200,112,42,0.95) !important;outline-offset:-2px;cursor:text !important;}'
      + '[data-canvas-text-editing="true"] *::selection{background:rgba(200,112,42,0.25);}'
      + '[data-canvas-dragging="true"], [data-canvas-dragging="true"] *{cursor:grabbing !important;user-select:none !important;}'
      // During a resize the whole document shows the grabbed handle's cursor
      // (the pointer outruns the 9px handle mid-gesture).
      + '[data-canvas-resizing] *{user-select:none !important;}'
      + '[data-canvas-resizing="nwse"], [data-canvas-resizing="nwse"] *{cursor:nwse-resize !important;}'
      + '[data-canvas-resizing="nesw"], [data-canvas-resizing="nesw"] *{cursor:nesw-resize !important;}'
      + '[data-canvas-resizing="ns"], [data-canvas-resizing="ns"] *{cursor:ns-resize !important;}'
      + '[data-canvas-resizing="ew"], [data-canvas-resizing="ew"] *{cursor:ew-resize !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function sectionAt(position) {
    var sec = document.querySelector('[data-canvas-position="' + position + '"]');
    if (sec) return sec;
    var all = document.querySelectorAll('section.slide, section[data-canvas-position]');
    return all[position] || null;
  }

  function safePost(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (err) { /* parent gone */ }
  }

  function startEdit(position) {
    stopEdit();
    var sec = sectionAt(position);
    if (!sec) { safePost({ type: 'canvas:edit-ready', position: position, ok: false }); return; }
    ensureStyle();
    sec.setAttribute('contenteditable', 'true');
    sec.setAttribute('spellcheck', 'false');
    sec.setAttribute('data-canvas-editing', 'true');
    editing = { section: sec, position: position };
    try { sec.focus(); } catch (e) { /* not focusable; user clicks in */ }
    safePost({ type: 'canvas:edit-ready', position: position, ok: true });
  }

  function stopEdit() {
    if (!editing) return;
    var sec = editing.section;
    sec.removeAttribute('contenteditable');
    sec.removeAttribute('spellcheck');
    sec.removeAttribute('data-canvas-editing');
    editing = null;
  }

  function serialize(section) {
    var clone = section.cloneNode(true);
    clone.removeAttribute('data-canvas-position');
    clone.removeAttribute('data-canvas-editing');
    clone.removeAttribute('contenteditable');
    clone.removeAttribute('spellcheck');
    clone.removeAttribute('data-canvas-picking');
    var marked = clone.querySelectorAll('[contenteditable],[data-canvas-editing],[spellcheck]');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute('contenteditable');
      marked[i].removeAttribute('data-canvas-editing');
      marked[i].removeAttribute('spellcheck');
    }
    // Inspector/pick leftovers — inspect-save serializes BEFORE stopInspect,
    // so the selection/hover/text-edit markers are still on the live DOM.
    var insp = clone.querySelectorAll('[data-canvas-inspect-selected],[data-canvas-pick-hover],[data-canvas-text-editing]');
    for (var j = 0; j < insp.length; j++) {
      insp[j].removeAttribute('data-canvas-inspect-selected');
      insp[j].removeAttribute('data-canvas-pick-hover');
      insp[j].removeAttribute('data-canvas-text-editing');
    }
    return clone.outerHTML.replace(ASSET_SIG_RE, '$1');
  }

  // ---- element pick mode ---------------------------------------------------

  function describeEl(el) {
    var d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean);
    if (cls.length) d += '.' + cls.slice(0, 3).join('.');
    return d;
  }

  function serializeElement(el) {
    var clone = el.cloneNode(true);
    clone.removeAttribute('data-canvas-pick-hover');
    clone.removeAttribute('data-canvas-position');
    var marked = clone.querySelectorAll('[data-canvas-pick-hover]');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-canvas-pick-hover');
    return clone.outerHTML.replace(ASSET_SIG_RE, '$1');
  }

  function setHovered(el) {
    if (!picking) return;
    if (picking.hovered === el) return;
    if (picking.hovered) picking.hovered.removeAttribute('data-canvas-pick-hover');
    picking.hovered = el;
    if (el) el.setAttribute('data-canvas-pick-hover', 'true');
  }

  function onPickMove(e) {
    if (!picking) return;
    var el = e.target;
    // Only elements INSIDE the slide section are pickable; the section itself
    // is the "whole slide" fallback the per-slide prompt already covers.
    if (!(el instanceof Element) || el === picking.section || !picking.section.contains(el)) {
      setHovered(null);
      return;
    }
    setHovered(el);
  }

  function onPickClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    var el = picking.hovered;
    var pos = picking.position;
    if (!el) { return; }
    // Capture BEFORE stopPick clears the hover attribute.
    var html = serializeElement(el);
    var descriptor = describeEl(el);
    // Viewport-relative rect: the host iframe fills its wrapper 1:1, so these
    // coordinates let the host anchor its "copied" popover ON the element.
    var r = el.getBoundingClientRect();
    stopPick();
    safePost({ type: 'canvas:element-picked', position: pos, html: html, descriptor: descriptor, rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  }

  function onPickKey(e) {
    if (picking && e.key === 'Escape') {
      stopPick();
      safePost({ type: 'canvas:pick-cancelled' });
    }
  }

  function startPick(position) {
    stopPick();
    stopEdit();
    var sec = sectionAt(position);
    if (!sec) { safePost({ type: 'canvas:pick-ready', position: position, ok: false }); return; }
    ensureStyle();
    sec.setAttribute('data-canvas-picking', 'true');
    picking = { section: sec, position: position, hovered: null };
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    safePost({ type: 'canvas:pick-ready', position: position, ok: true });
  }

  function stopPick() {
    if (!picking) return;
    setHovered(null);
    picking.section.removeAttribute('data-canvas-picking');
    picking = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
  }

  // ---- inspect mode (direct-manipulation inspector) -------------------------

  // Computed colors come back as rgb()/rgba(); the host's <input type=color>
  // needs hex. Fully transparent maps to '' ("no fill").
  function toHexColor(c) {
    var m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c || '');
    if (!m) return '';
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return '';
    function h(n) { var s = (+n).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }

  // The control-panel snapshot for a selection. Uses computed style (not
  // getBoundingClientRect) so a transform-scaled deck reports layout px —
  // the same unit inspect-set writes back.
  function snapshotStyles(el) {
    var cs = window.getComputedStyle(el);
    var pt = parseFloat(cs.paddingTop), pr = parseFloat(cs.paddingRight);
    var pb = parseFloat(cs.paddingBottom), pl = parseFloat(cs.paddingLeft);
    var align = cs.textAlign;
    if (align === 'start') align = 'left';
    if (align === 'end') align = 'right';
    return {
      fontSize: Math.round(parseFloat(cs.fontSize)) || null,
      fontWeight: parseInt(cs.fontWeight, 10) || null,
      color: toHexColor(cs.color),
      background: toHexColor(cs.backgroundColor),
      textAlign: align,
      padding: (pt === pr && pt === pb && pt === pl) ? Math.round(pt) : null,
      width: Math.round(parseFloat(cs.width)) || null,
      height: Math.round(parseFloat(cs.height)) || null,
      positionMode: (cs.position === 'absolute' || cs.position === 'fixed') ? 'absolute' : 'flow'
    };
  }

  // Only props the inspector's controls (and nudge) emit — a hostile or buggy
  // host message can't write arbitrary CSS through this.
  var INSPECT_PROPS = { 'font-size': 1, 'font-weight': 1, 'color': 1, 'background-color': 1, 'text-align': 1, 'padding': 1, 'width': 1, 'height': 1, 'left': 1, 'top': 1, 'margin-left': 1, 'margin-top': 1 };

  function applyInspectStyles(styles) {
    if (!inspecting || !inspecting.selected || !styles || typeof styles !== 'object') return;
    var el = inspecting.selected;
    for (var k in styles) {
      if (!INSPECT_PROPS[k]) continue;
      var v = styles[k];
      if (v === null || v === '') el.style.removeProperty(k);
      else el.style.setProperty(k, String(v));
    }
  }

  // ---- positioning: shared by arrow-key nudge and pointer drag --------------
  //
  // Two move channels, chosen by the element's own layout:
  //   absolute/fixed -> left/top        (its position already lives in coords)
  //   flow           -> transform: translate(...)  (a flow element has no x/y to
  //     write; translate offsets it visually WITHOUT reflowing siblings, unlike
  //     margin). Any transform the element already carries is captured ONCE per
  //     session in tfState, so repeated moves stay a single managed translate().
  function moveMode(el) {
    var p = window.getComputedStyle(el).position;
    return (p === 'absolute' || p === 'fixed') ? 'abs' : 'flow';
  }
  function tfFor(el) {
    var s = tfState.get(el);
    if (s) return s;
    var base = el.style.transform || '';
    if (!base) { var c = window.getComputedStyle(el).transform; if (c && c !== 'none') base = c; }
    s = { base: base, tx: 0, ty: 0 };
    tfState.set(el, s);
    return s;
  }
  function readOffset(el, mode) {
    if (mode === 'abs') {
      var cs = window.getComputedStyle(el);
      return { x: parseFloat(cs.left) || 0, y: parseFloat(cs.top) || 0 };
    }
    var st = tfFor(el);
    return { x: st.tx, y: st.ty };
  }
  function applyOffset(el, mode, x, y) {
    if (mode === 'abs') {
      el.style.setProperty('left', Math.round(x) + 'px');
      el.style.setProperty('top', Math.round(y) + 'px');
      return;
    }
    var st = tfFor(el);
    st.tx = x; st.ty = y;
    el.style.setProperty('transform', (st.base ? st.base + ' ' : '') + 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)');
  }
  function sectionScale(sec) {
    return cvStageScale(sec.getBoundingClientRect().width, sec.offsetWidth);
  }

  // ---- resize handles: 8 grips pinned to the selection's on-screen box -------
  //
  // The grips live OUTSIDE the slide <section> (appended to <body>), so
  // serialize() can never leak them into saved HTML, and their on-screen size
  // stays constant regardless of the deck's stage scale. A rAF loop (running
  // only while a selection exists) re-reads the selection's rect each frame —
  // cheaper than enumerating every reflow source (style writes, text edits,
  // images loading, host resizes) and immune to missing one.
  var HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

  function ensureHandleLayer() {
    if (handleLayer) return handleLayer;
    var layer = document.createElement('div');
    layer.setAttribute('data-canvas-handles', 'true');
    layer.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;display:none;';
    for (var k in HANDLE_CURSORS) {
      var g = document.createElement('div');
      g.setAttribute('data-canvas-handle', k);
      g.style.cssText = 'position:absolute;width:9px;height:9px;margin:-5px 0 0 -5px;background:#fff;border:1.5px solid rgba(200,112,42,0.95);border-radius:2px;box-sizing:border-box;pointer-events:auto;cursor:' + HANDLE_CURSORS[k] + ';';
      layer.appendChild(g);
    }
    (document.body || document.documentElement).appendChild(layer);
    handleLayer = layer;
    return layer;
  }

  function syncHandles() {
    if (!handleLayer) return;
    var el = inspecting && inspecting.selected;
    // Grips vanish while typing: they sit ON the box edge, where a click should
    // place the caret, not start a resize.
    if (!el || textEditing) { handleLayer.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    handleLayer.style.display = 'block';
    var cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    for (var i = 0; i < handleLayer.children.length; i++) {
      var g = handleLayer.children[i];
      var k = g.getAttribute('data-canvas-handle');
      g.style.left = (k.indexOf('w') !== -1 ? r.left : (k.indexOf('e') !== -1 ? r.right : cx)) + 'px';
      g.style.top = (k.indexOf('n') !== -1 ? r.top : (k.indexOf('s') !== -1 ? r.bottom : cy)) + 'px';
    }
  }

  function startHandleLoop() {
    ensureHandleLayer();
    syncHandles();
    if (handleRaf || typeof requestAnimationFrame !== 'function') return;
    var loop = function () { syncHandles(); handleRaf = requestAnimationFrame(loop); };
    handleRaf = requestAnimationFrame(loop);
  }

  function stopHandleLoop() {
    if (handleRaf) { cancelAnimationFrame(handleRaf); handleRaf = 0; }
    if (handleLayer) handleLayer.style.display = 'none';
  }

  // Arrow keys (host or iframe) move the selection by whole authoring px,
  // clamped to the slide just like a drag.
  function nudgeSelected(dx, dy) {
    if (!inspecting || !inspecting.selected) return;
    var el = inspecting.selected, sec = inspecting.section;
    var mode = moveMode(el);
    var off = readOffset(el, mode);
    var scale = sectionScale(sec);
    var c = cvClampDelta(dx * scale, dy * scale, el.getBoundingClientRect(), sec.getBoundingClientRect());
    applyOffset(el, mode, off.x + c.dx / scale, off.y + c.dy / scale);
  }

  // ---- pointer drag: Model A (free move, clamped to the slide) ---------------
  // Geometry is captured once at pointerdown (the rects don't move under us
  // mid-gesture — only the element's own offset changes), so each move clamps
  // the TOTAL screen delta and folds it back through the stage scale. The same
  // plumbing carries both gestures: dragging.handle is null for a move and the
  // grabbed grip's name for a resize.
  function onDragMove(e) {
    if (!dragging) return;
    var dxs = e.clientX - dragging.startX;
    var dys = e.clientY - dragging.startY;
    if (!dragging.moved) {
      if (Math.abs(dxs) + Math.abs(dys) < 3) return; // threshold: a click is not a drag
      dragging.moved = true;
      if (document.body) {
        if (dragging.handle) document.body.setAttribute('data-canvas-resizing', HANDLE_CURSORS[dragging.handle].replace('-resize', ''));
        else document.body.setAttribute('data-canvas-dragging', 'true');
      }
    }
    if (dragging.handle) {
      var rc = cvResizeClamp(dragging.handle, dxs, dys, dragging.elRect, dragging.secRect, 8 * dragging.scale, e.shiftKey ? dragging.ratio : 0);
      applyResize(rc.dx / dragging.scale, rc.dy / dragging.scale);
    } else {
      var c = cvClampDelta(dxs, dys, dragging.elRect, dragging.secRect);
      applyOffset(dragging.el, dragging.mode, dragging.baseX + c.dx / dragging.scale, dragging.baseY + c.dy / dragging.scale);
    }
    if (e.cancelable) e.preventDefault();
  }
  function endDrag(e) {
    if (!dragging) return;
    var cap = dragging.captureEl || dragging.el;
    try { if (e && cap.releasePointerCapture && typeof e.pointerId === 'number') cap.releasePointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    document.removeEventListener('pointermove', onDragMove, true);
    document.removeEventListener('pointerup', endDrag, true);
    document.removeEventListener('pointercancel', endDrag, true);
    if (document.body) {
      document.body.removeAttribute('data-canvas-dragging');
      document.body.removeAttribute('data-canvas-resizing');
    }
    // A finished resize re-posts the snapshot so the host panel's Width/Height
    // fields reflect the new box (commitTextEdit does the same for text).
    if (dragging.handle && dragging.moved && inspecting && inspecting.selected === dragging.el) {
      safePost({ type: 'canvas:element-selected', position: inspecting.position, descriptor: describeEl(dragging.el), styles: snapshotStyles(dragging.el) });
    }
    dragging = null;
  }

  // Fold a clamped resize delta (authoring px) into styles. A west/north edge
  // also shifts the box so the opposite edge stays anchored — left/top for
  // absolute elements, the managed translate for flow (the same channel as
  // drag, so a later move composes instead of stacking transforms).
  function applyResize(dx, dy) {
    var d = dragging, el = d.el, hnd = d.handle;
    var hasE = hnd.indexOf('e') !== -1, hasW = hnd.indexOf('w') !== -1;
    var hasS = hnd.indexOf('s') !== -1, hasN = hnd.indexOf('n') !== -1;
    if (hasE || hasW) el.style.setProperty('width', Math.round(hasE ? d.baseW + dx : d.baseW - dx) + 'px');
    if (hasS || hasN) el.style.setProperty('height', Math.round(hasS ? d.baseH + dy : d.baseH - dy) + 'px');
    if (hasW || hasN) applyOffset(el, d.mode, d.baseX + (hasW ? dx : 0), d.baseY + (hasN ? dy : 0));
  }

  function onResizeStart(e, grip) {
    if (!inspecting || !inspecting.selected) return;
    var hnd = grip.getAttribute('data-canvas-handle');
    if (!HANDLE_CURSORS[hnd]) return;
    var el = inspecting.selected;
    var sec = inspecting.section;
    suppressClick = true;
    var mode = moveMode(el);
    var off = readOffset(el, mode);
    var scale = sectionScale(sec);
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    // Authoring-px size: computed style where it resolves; the on-screen rect
    // folded back through the stage scale as the fallback.
    var baseW = parseFloat(cs.width);
    if (!isFinite(baseW)) baseW = (r.right - r.left) / scale;
    var baseH = parseFloat(cs.height);
    if (!isFinite(baseH)) baseH = (r.bottom - r.top) / scale;
    dragging = {
      el: el, mode: mode, handle: hnd, captureEl: grip,
      startX: e.clientX, startY: e.clientY,
      baseX: off.x, baseY: off.y,
      baseW: baseW, baseH: baseH,
      ratio: (baseW > 0 && baseH > 0) ? baseW / baseH : 0,
      secRect: sec.getBoundingClientRect(),
      elRect: r,
      scale: scale,
      moved: false
    };
    try { if (grip.setPointerCapture && typeof e.pointerId === 'number') grip.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    if (e.cancelable) e.preventDefault();
  }
  function onDragStart(e) {
    if (!inspecting) return;
    if (typeof e.button === 'number' && e.button !== 0) return; // primary button only
    var el = e.target;
    // A press on a resize grip is a resize, not a move — the grips live outside
    // the section, so they'd fall through the containment check below.
    if (el instanceof Element && el.hasAttribute('data-canvas-handle')) { onResizeStart(e, el); return; }
    if (!(el instanceof Element) || el === inspecting.section || !inspecting.section.contains(el)) return;
    // A pointerdown inside the element being typed in is a caret placement /
    // text-selection gesture, not a move — leave it to the browser.
    if (textEditing && textEditing.el.contains(el)) return;
    // Select on pointerdown so a press-drag moves the element under the cursor
    // in one gesture; the trailing click is swallowed (suppressClick) so it
    // doesn't re-fire selection.
    if (el !== inspecting.selected) selectInspectEl(el);
    suppressClick = true;
    var mode = moveMode(el);
    var off = readOffset(el, mode);
    var sec = inspecting.section;
    dragging = {
      el: el, mode: mode, handle: null, captureEl: el,
      startX: e.clientX, startY: e.clientY,
      baseX: off.x, baseY: off.y,
      secRect: sec.getBoundingClientRect(),
      elRect: el.getBoundingClientRect(),
      scale: sectionScale(sec),
      moved: false
    };
    try { if (el.setPointerCapture && typeof e.pointerId === 'number') el.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    document.addEventListener('pointermove', onDragMove, true);
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    if (e.cancelable) e.preventDefault();
  }

  function setInspectHover(el) {
    if (!inspecting) return;
    if (inspecting.hovered === el) return;
    if (inspecting.hovered) inspecting.hovered.removeAttribute('data-canvas-pick-hover');
    inspecting.hovered = el;
    if (el) el.setAttribute('data-canvas-pick-hover', 'true');
  }

  function selectInspectEl(el) {
    if (!inspecting) return;
    // Switching/clearing the selection finalizes any in-place text edit on the
    // OUTGOING element first, so the typed text is committed (not lost) before
    // the new snapshot is posted.
    if (textEditing && textEditing.el !== el) commitTextEdit();
    if (inspecting.selected) inspecting.selected.removeAttribute('data-canvas-inspect-selected');
    inspecting.selected = el;
    if (el) {
      el.setAttribute('data-canvas-inspect-selected', 'true');
      startHandleLoop();
      safePost({ type: 'canvas:element-selected', position: inspecting.position, descriptor: describeEl(el), styles: snapshotStyles(el) });
    } else {
      stopHandleLoop();
      safePost({ type: 'canvas:inspect-deselected' });
    }
  }

  // ---- in-place text editing (double-click a selected element) --------------
  //
  // The inspector's style/position controls couldn't fix a typo — that forced a
  // trip out to the raw-HTML editor. Double-clicking an element (or the host
  // posting canvas:inspect-text) turns the SELECTED element contenteditable so
  // the user types the correction exactly where it renders. The text lives in
  // the same <section> the inspector serializes on Save, so it flows through the
  // identical saveSlideHtmlDirect versioning as a style change — no new persist
  // path. Enter / Escape / blur / clicking another element commit it.
  function beginTextEdit(el) {
    if (!inspecting || !(el instanceof Element)) return;
    if (el === inspecting.section || !inspecting.section.contains(el)) return;
    if (textEditing && textEditing.el === el) return;
    if (textEditing) commitTextEdit();
    // Editing always targets the SELECTED element, so a double-click both
    // selects and edits in one gesture.
    if (el !== inspecting.selected) selectInspectEl(el);
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('data-canvas-text-editing', 'true');
    textEditing = { el: el };
    el.addEventListener('blur', onTextBlur, true);
    try { el.focus(); } catch (e) { /* not focusable; caret lands on click */ }
    // Drop any existing page selection into the element so typing replaces from
    // the caret rather than appending at a stale range.
    try {
      var sel = window.getSelection && window.getSelection();
      if (sel && document.createRange) {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e2) { /* selection API unavailable */ }
    safePost({ type: 'canvas:inspect-text-state', position: inspecting.position, editing: true });
  }

  function commitTextEdit() {
    if (!textEditing) return;
    var el = textEditing.el;
    el.removeEventListener('blur', onTextBlur, true);
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    el.removeAttribute('data-canvas-text-editing');
    textEditing = null;
    // The typed text is already in the live DOM; just refresh the host snapshot
    // (the element's box may have grown/shrunk) and flip the hint back.
    if (inspecting && inspecting.selected === el) {
      safePost({ type: 'canvas:element-selected', position: inspecting.position, descriptor: describeEl(el), styles: snapshotStyles(el) });
    }
    if (inspecting) {
      safePost({ type: 'canvas:inspect-text-state', position: inspecting.position, editing: false });
    }
  }

  function onTextBlur() {
    // Focus left the editable element (clicked elsewhere, tabbed away) — commit.
    commitTextEdit();
  }

  function onInspectDblClick(e) {
    if (!inspecting) return;
    var el = e.target;
    if (!(el instanceof Element) || el === inspecting.section || !inspecting.section.contains(el)) return;
    e.preventDefault();
    e.stopPropagation();
    beginTextEdit(el);
  }

  function onInspectMove(e) {
    // No hover highlight while text editing — the user is selecting characters,
    // not aiming at a new element.
    if (!inspecting || dragging || textEditing) return;
    var el = e.target;
    if (!(el instanceof Element) || el === inspecting.section || el === inspecting.selected || !inspecting.section.contains(el)) {
      setInspectHover(null);
      return;
    }
    setInspectHover(el);
  }

  function onInspectClick(e) {
    if (!inspecting) return;
    var el = e.target;
    // While text editing, clicks INSIDE the editable element place the caret —
    // let them through untouched (don't preventDefault, don't re-select). A
    // click elsewhere falls through to the commit + reselect path below (the
    // blur handler also fires, so commit is idempotent).
    if (textEditing && el instanceof Element && textEditing.el.contains(el)) {
      return;
    }
    // Always swallow other clicks — the deck's own onclick handlers (modals,
    // dots) must not fire while the user is aiming the inspector.
    e.preventDefault();
    e.stopPropagation();
    // A pointer gesture already handled selection on pointerdown (and may have
    // been a drag); consume its trailing click without re-selecting.
    if (suppressClick) { suppressClick = false; return; }
    if (!(el instanceof Element) || el === inspecting.section || !inspecting.section.contains(el)) return;
    setInspectHover(null);
    selectInspectEl(el);
  }

  var NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  // Capture-phase on document, so stopPropagation beats the controller's
  // window-level canvas:key forwarder — a nudge must never page slides.
  function onInspectKey(e) {
    if (!inspecting) return;
    // While typing, hand keys to the browser's caret — arrows move the cursor,
    // Enter inserts a break — EXCEPT Escape, which commits the text and keeps
    // the element selected (so the user lands back on the style controls). We
    // still stopPropagation so the host's slide-nav arrows stay suppressed.
    if (textEditing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        commitTextEdit();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!inspecting.selected) return;
      e.preventDefault();
      e.stopPropagation();
      selectInspectEl(null);
      return;
    }
    var d = NUDGE_KEYS[e.key];
    if (d && inspecting.selected) {
      e.preventDefault();
      e.stopPropagation();
      var f = e.shiftKey ? 10 : 1;
      nudgeSelected(d[0] * f, d[1] * f);
    }
  }

  function startInspect(position) {
    stopInspect();
    stopPick();
    stopEdit();
    var sec = sectionAt(position);
    if (!sec) { safePost({ type: 'canvas:inspect-ready', position: position, ok: false }); return; }
    ensureStyle();
    // Reuses the pick cursor rule; modes are mutually exclusive so the
    // attribute can't be contested.
    sec.setAttribute('data-canvas-picking', 'true');
    inspecting = { section: sec, position: position, hovered: null, selected: null };
    suppressClick = false;
    document.addEventListener('mousemove', onInspectMove, true);
    document.addEventListener('pointerdown', onDragStart, true);
    document.addEventListener('click', onInspectClick, true);
    document.addEventListener('dblclick', onInspectDblClick, true);
    document.addEventListener('keydown', onInspectKey, true);
    safePost({ type: 'canvas:inspect-ready', position: position, ok: true });
  }

  function stopInspect() {
    if (!inspecting) return;
    // Finalize any open text edit so its typed text is in the DOM the host
    // serialized (inspect-save runs serialize() BEFORE stopInspect) and is left
    // clean (no stray contenteditable) for the discard-by-remount cancel path.
    if (textEditing) commitTextEdit();
    if (dragging) endDrag();
    stopHandleLoop();
    setInspectHover(null);
    if (inspecting.selected) inspecting.selected.removeAttribute('data-canvas-inspect-selected');
    inspecting.section.removeAttribute('data-canvas-picking');
    inspecting = null;
    suppressClick = false;
    document.removeEventListener('mousemove', onInspectMove, true);
    document.removeEventListener('pointerdown', onDragStart, true);
    document.removeEventListener('click', onInspectClick, true);
    document.removeEventListener('dblclick', onInspectDblClick, true);
    document.removeEventListener('keydown', onInspectKey, true);
  }

  window.addEventListener('message', function (e) {
    var data = e && e.data;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'canvas:edit-start') {
      stopPick();
      stopInspect();
      startEdit(typeof data.position === 'number' ? data.position : 0);
    } else if (data.type === 'canvas:edit-cancel') {
      stopEdit();
    } else if (data.type === 'canvas:edit-save') {
      var html = editing ? serialize(editing.section) : null;
      var pos = editing ? editing.position : (typeof data.position === 'number' ? data.position : 0);
      stopEdit();
      safePost({ type: 'canvas:slide-html', position: pos, html: html });
    } else if (data.type === 'canvas:pick-start') {
      stopInspect();
      startPick(typeof data.position === 'number' ? data.position : 0);
    } else if (data.type === 'canvas:pick-cancel') {
      stopPick();
    } else if (data.type === 'canvas:inspect-start') {
      startInspect(typeof data.position === 'number' ? data.position : 0);
    } else if (data.type === 'canvas:inspect-cancel') {
      stopInspect();
    } else if (data.type === 'canvas:inspect-set') {
      applyInspectStyles(data.styles);
    } else if (data.type === 'canvas:inspect-nudge') {
      nudgeSelected(+data.dx || 0, +data.dy || 0);
    } else if (data.type === 'canvas:inspect-parent') {
      if (inspecting && inspecting.selected) {
        var par = inspecting.selected.parentElement;
        if (par && par !== inspecting.section && inspecting.section.contains(par)) selectInspectEl(par);
      }
    } else if (data.type === 'canvas:inspect-deselect') {
      if (inspecting && inspecting.selected) selectInspectEl(null);
    } else if (data.type === 'canvas:inspect-text') {
      // Host-initiated text edit (mirrors the double-click). Begins editing the
      // current selection in place; same commit paths apply.
      if (inspecting && inspecting.selected) beginTextEdit(inspecting.selected);
    } else if (data.type === 'canvas:inspect-save') {
      // Finalize any open text edit so its typed characters are committed into
      // the section we serialize. Serialize BEFORE stopInspect so serialize()
      // can strip the live selection markers; the styles + text the user
      // applied stay in the DOM and are exactly what gets persisted.
      if (textEditing) commitTextEdit();
      var ihtml = inspecting ? serialize(inspecting.section) : null;
      var ipos = inspecting ? inspecting.position : (typeof data.position === 'number' ? data.position : 0);
      stopInspect();
      safePost({ type: 'canvas:slide-html', position: ipos, html: ihtml });
    } else if (data.type === 'canvas:navigate') {
      // The host clears its pick/inspect state render-side when the slide
      // changes and can't postMessage from render — treat a navigate to a
      // DIFFERENT slide as the cancel, so the document-wide listeners (incl.
      // click preventDefault) never outlive the slide they were aimed at. A
      // SAME-slide navigate must NOT cancel: the host re-posts navigate for
      // same-slide reasons (clearing a proposal compare in the very tick it
      // starts a pick — startElementPick → clearProposalReview flips
      // activeProposalId, and the navigate effect keys on it), and canceling
      // then tears the crosshair down the instant it appears. Unknown target →
      // cancel (the original behaviour).
      var navPos = typeof data.position === 'number' ? data.position : null;
      if (picking && (navPos === null || picking.position !== navPos)) stopPick();
      if (inspecting && (navPos === null || inspecting.position !== navPos)) stopInspect();
    }
  });
})();
`.trim();

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
