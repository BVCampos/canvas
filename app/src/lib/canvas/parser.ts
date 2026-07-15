// HTML deck parser — phase 1.
//
// Pure function. Given a Claude-generated HTML deck (one big <html> file with
// inline <style>, <script>, and ordered <section class="slide ...">), returns a
// normalised shape ready for the importer to insert. The importer handles
// Storage uploads + DB rows; this file does no I/O.
//
// Decomposition rules (matching the seed `teste.html`):
//   - <title>            → deck.title
//   - <html lang="...">  → deck.lang
//   - <meta name="..." content="..."> → deck.meta
//   - all top-level <style> blocks    → deck.theme_css (joined with "\n\n")
//   - all top-level <script> blocks   → deck.nav_js   (joined with "\n\n")
//   - each slide element       → deck.slides[] (preserves source order)
//   - <img src="data:...">  → deck.assets[] + src rewritten to a placeholder
//                            token that the importer replaces with the public
//                            asset proxy URL once the row is inserted.
//
// Slide detection is TIERED so Canvas accepts the range of shapes Claude
// emits, not just the canonical one. We fall to the next tier only when the
// prior one finds nothing, so canonical decks keep their exact decomposition:
//   Tier 1 — top-level <section class="slide">  (the documented shape).
//   Tier 2 — outermost <div|section|article class="slide"> anywhere
//            (e.g. <div class="slide"> inside a <div class="slides"> track —
//            a very common Claude variant that used to import as 0 slides).
//   Tier 3 — last resort: direct children of an explicit slide container
//            (#slides / .slides) when the slides aren't class-marked at all.
// Whatever the source element, each slide is normalised to a
// <section class="slide …"> wrapper before storage.
//
// We don't use a DOM library; Claude decks have a predictable shape and a
// hand-rolled extractor keeps the build lean. The walkers are small stack
// machines over open/close tag events so they survive nested elements.

const ASSET_PLACEHOLDER_PREFIX = "__CANVAS_ASSET_";

export type ParsedAsset = {
  /** Stable token written into html_body where the data: URL used to live. */
  placeholder_id: string;
  /** The full original `data:...` URL — kept for debugging / audit. */
  original_src: string;
  mime_type: string;
  data: Uint8Array;
};

export type ParsedSlide = {
  position: number;
  title: string;
  /** Extra class names on the `<section class="slide ...">` (excluding `slide`). */
  class_modifiers: string[];
  /** Inner HTML of the <section>, with image data URLs replaced by placeholders. */
  html_body: string;
  /** Slide-scoped CSS. v1 leaves this empty — all CSS lives in deck.theme_css. */
  slide_styles: string;
};

export type ParsedDeck = {
  title: string;
  lang: string;
  /**
   * `<meta name content>` pairs plus a `font_links` array (see below). The
   * importer spreads this whole object into the deck's `meta` JSON column, so a
   * `string[]` value rides along untouched — the name/content loop only ever
   * writes strings into it.
   */
  meta: Record<string, string | string[]>;
  theme_css: string;
  nav_js: string;
  slides: ParsedSlide[];
  assets: ParsedAsset[];
  /**
   * Non-slide body markup the deck's nav_js depends on — modal overlays,
   * dots rails, arrow buttons, tooltip layers. Standalone decks ship these as
   * siblings of the slide track; dropping them (the old behaviour) left the
   * deck's interactivity handlers (`onclick="openModal('d1')"`) crashing on
   * `getElementById(...) === null`, so click-driven slides went dead in
   * Canvas. Preserved verbatim (asset URLs placeholder-rewritten like slide
   * bodies) and re-injected by `assembleDeckHtml` behind a
   * `data-canvas="deck-chrome"` wrapper. Empty string when the deck has no
   * extra chrome (the canonical Canvas-native shape).
   */
  chrome_html: string;
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function parseDeckHtml(html: string): ParsedDeck {
  const rawTitle = matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim();
  const title = rawTitle ? decodeEntities(rawTitle) : "Untitled deck";
  const lang =
    matchOne(html, /<html\b[^>]*\blang\s*=\s*"([^"]+)"/i) ??
    matchOne(html, /<html\b[^>]*\blang\s*=\s*'([^']+)'/i) ??
    "en";

  const meta: Record<string, string | string[]> = {};
  const metaRe = /<meta\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*\bcontent\s*=\s*"([^"]*)"[^>]*>/gi;
  for (let m: RegExpExecArray | null; (m = metaRe.exec(html)); ) {
    meta[m[1]] = m[2];
  }

  // Preserve web-font <link rel="stylesheet"> hrefs that point at a known font
  // host. The parser otherwise hoists only inline <style>/<script> and throws
  // the whole <head> away, so a `<link rel="stylesheet"
  // href="https://fonts.googleapis.com/css2?family=Inter">` was silently
  // dropped at import and the deck fell back to a system font the instant it
  // entered Canvas. We keep the hrefs in meta.font_links so assembleDeckHtml
  // can re-emit them in <head> (preview keeps the live font; export then
  // inlines them into a self-contained file). Allowlisted hosts only — a bare
  // <link> to an arbitrary origin is left out rather than re-emitted, so we
  // never resurrect a tracking/analytics stylesheet a deck happened to carry.
  const fontLinks = extractFontLinks(html);
  if (fontLinks.length > 0) meta.font_links = fontLinks;

  const styles = extractAll(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi);
  const scripts = extractAll(html, /<script\b[^>]*>([\s\S]*?)<\/script>/gi);

  const nav_js = scripts.join("\n\n").trim();

  const assets: ParsedAsset[] = [];
  let assetCounter = 0;

  // Lift inline data: URLs out of the deck's shared CSS BEFORE the slide pass,
  // so CSS-background images and <img src="data:"> images share one counter and
  // sink. The parser used to hoist only <img> data URLs, leaving CSS
  // `background-image:url(data:…)` inline in theme_css — and one cover photo
  // baked in that way (one real weekly deck carried a 280 KB JPEG) was re-sent on every
  // slide render. The importer rewrites theme_css placeholders the same way it
  // rewrites slide bodies.
  const rawTheme = styles.join("\n\n").trim();
  const themeExtract = extractCssAssets(rawTheme, assetCounter, assets);
  const theme_css = themeExtract.css;
  assetCounter = themeExtract.nextCounter;

  const slideEls = collectSlideElements(html);

  const slides: ParsedSlide[] = [];
  let position = 0;
  for (const el of slideEls) {
    const { html: rewritten, nextCounter } = extractAssets(el.body, assetCounter, assets);
    assetCounter = nextCounter;

    const classModifiers = el.classNames.filter((c) => c !== "slide");
    const slideTitle = pickSlideTitle(rewritten, classModifiers);

    slides.push({
      position,
      title: slideTitle,
      class_modifiers: classModifiers,
      html_body: wrapSlideBody(el.classNames, rewritten),
      slide_styles: "",
    });
    position += 1;
  }

  // Preserve non-slide body chrome (modal overlays, dots rails, …) that the
  // deck's nav_js drives via getElementById. Asset URLs inside it share the
  // slides' placeholder counter so the importer rewrites them the same way.
  const rawChrome = extractChromeHtml(html, slideEls);
  const chromeExtract = extractAssets(rawChrome, assetCounter, assets);
  const chrome_html = chromeExtract.html.trim();
  assetCounter = chromeExtract.nextCounter;

  return { title, lang, meta, theme_css, nav_js, slides, assets, chrome_html };
}

// Container tags that can hold deck chrome at the body's top level. Kept to
// block/sectioning elements — text nodes, void tags, and inline markup at the
// body root are not chrome the nav_js would address by id.
const CHROME_TAGS = "div|section|article|aside|nav|header|footer|main|button|figure";

/**
 * Everything in `<body>` that is NOT a slide, a slide-bearing wrapper, or a
 * script/style: the deck's interaction chrome. We walk the body's top-level
 * container elements and, for each:
 *   - skip it when it IS a slide (or sits inside one) — that markup already
 *     lives in a ParsedSlide;
 *   - recurse into it when it CONTAINS slides (`.stage-area > .viewport >
 *     .track > .slide` wrappers) — the wrapper's own carousel job is replaced
 *     by Canvas's `.deck > #slides` structure, but chrome nested beside the
 *     slides inside it (arrow buttons, dots) still needs rescuing;
 *   - otherwise keep it verbatim (modal overlays, dots rails, tooltip layers).
 */
function extractChromeHtml(html: string, slideEls: TopLevelSection[]): string {
  if (slideEls.length === 0) return "";
  const bodyOpen = html.match(/<body\b[^>]*>/i);
  const from =
    bodyOpen && bodyOpen.index !== undefined
      ? bodyOpen.index + bodyOpen[0].length
      : 0;
  const closeIdx = html.search(/<\/body\s*>/i);
  const to = closeIdx === -1 ? html.length : closeIdx;
  const kept: string[] = [];
  collectChromeElements(html, from, to, slideEls, kept);
  return kept.join("\n");
}

function collectChromeElements(
  html: string,
  from: number,
  to: number,
  slideEls: TopLevelSection[],
  sink: string[],
): void {
  const openRe = new RegExp(`<(${CHROME_TAGS})\\b[^>]*>`, "gi");
  openRe.lastIndex = from;
  for (let m: RegExpExecArray | null; (m = openRe.exec(html)); ) {
    if (m.index >= to) return;
    const span = matchSameTagSpan(html, m[1].toLowerCase(), m.index, m[0].length);
    if (!span || span.elementEnd > to) continue; // unbalanced — skip, keep scanning inside
    const start = m.index;
    const end = span.elementEnd;
    const isOrInsideSlide = slideEls.some((s) => start >= s.start && end <= s.end);
    const containsSlide = slideEls.some((s) => s.start >= start && s.end <= end);
    if (!isOrInsideSlide) {
      if (containsSlide) {
        // Slide-bearing wrapper — drop the wrapper, rescue chrome inside it.
        collectChromeElements(html, span.bodyStart, span.bodyEnd, slideEls, sink);
      } else {
        // Scripts/styles inside the kept element were already lifted into
        // nav_js / theme_css — leaving them inline would execute them twice.
        sink.push(stripScriptAndStyleBlocks(html.slice(start, end)));
      }
    }
    openRe.lastIndex = end;
  }
}

function stripScriptAndStyleBlocks(s: string): string {
  return s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
}

/**
 * Tiered slide detection — see the file header. Returns the slide-bearing
 * elements in document order; the caller turns each into a ParsedSlide. Each
 * tier only runs when the previous one found nothing, so a canonical deck of
 * top-level `<section class="slide">` decomposes exactly as it always did.
 */
function collectSlideElements(html: string): TopLevelSection[] {
  // Tier 1 — top-level <section class="slide"> (unchanged legacy behaviour).
  const topLevel = walkTopLevelSections(html).filter((s) =>
    s.classNames.includes("slide"),
  );
  if (topLevel.length > 0) return topLevel;

  // Tier 2 — any outermost div/section/article carrying class="slide".
  const classMarked = walkSlideClassedElements(html);
  if (classMarked.length > 0) return classMarked;

  // Tier 3 — direct children of an explicit slides container, when the slides
  // themselves aren't class-marked.
  return walkSlidesContainerChildren(html);
}

/** Stable token used in slide html_body where the asset src used to live. */
export function assetPlaceholder(index: number): string {
  return `${ASSET_PLACEHOLDER_PREFIX}${index}__`;
}

/** Used by the importer to substitute placeholder tokens with real URLs. */
export function rewriteAssetPlaceholders(
  html: string,
  resolve: (placeholder: string) => string | undefined,
): string {
  return html.replace(/__CANVAS_ASSET_(\d+)__/g, (full) => resolve(full) ?? full);
}

// ---------------------------------------------------------------------------
// Web-font links
// ---------------------------------------------------------------------------

/**
 * Hosts we trust to serve web-font CSS / binaries. Kept deliberately tight:
 * the same allowlist gates BOTH the import-time link preservation here and the
 * export-time inliner's outbound fetches (export-assets.ts keeps its own copy
 * so the two server modules stay independent), so widening it widens the SSRF
 * surface of the exporter. A host matches when it equals an entry or is a
 * subdomain of one (`fonts.googleapis.com`, `*.gstatic.com`, …).
 */
export const FONT_HOST_ALLOWLIST = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
];

/** True when `url`'s host is on FONT_HOST_ALLOWLIST (exact or a subdomain). */
export function isAllowlistedFontUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // relative / malformed → not a remote font host we fetch
  }
  return FONT_HOST_ALLOWLIST.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * Collect `<link rel="stylesheet" href="…">` hrefs in the source whose host is
 * on the font allowlist, deduped, in document order. We match `rel` and `href`
 * in either attribute order and tolerate single or double quotes; a `<link>`
 * without `rel="stylesheet"` (preconnect, preload, icon) or pointing off the
 * allowlist is skipped. Google's font embed ships a `<link rel="preconnect">`
 * pair beside the stylesheet — those are a fetch optimisation, not the font, so
 * dropping them is correct (the stylesheet link alone still loads the font).
 */
function extractFontLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  for (let m: RegExpExecArray | null; (m = linkRe.exec(html)); ) {
    const tag = m[0];
    const rel = (
      matchOne(tag, /\brel\s*=\s*"([^"]*)"/i) ??
      matchOne(tag, /\brel\s*=\s*'([^']*)'/i) ??
      ""
    ).toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const hrefRaw =
      matchOne(tag, /\bhref\s*=\s*"([^"]*)"/i) ??
      matchOne(tag, /\bhref\s*=\s*'([^']*)'/i);
    if (!hrefRaw) continue;
    const href = decodeEntities(hrefRaw).trim();
    if (!isAllowlistedFontUrl(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function matchOne(s: string, re: RegExp): string | undefined {
  const m = s.match(re);
  return m?.[1];
}

function extractAll(s: string, re: RegExp): string[] {
  const out: string[] = [];
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) out.push(m[1]);
  return out;
}

type SectionEvent =
  | { kind: "open"; index: number; len: number; classNames: string[] }
  | { kind: "close"; index: number; len: number };

type TopLevelSection = {
  openTag: string;
  body: string;
  classNames: string[];
  /** Span of the whole element (open tag through close tag) in source-html offsets. */
  start: number;
  end: number;
};

function walkTopLevelSections(html: string): TopLevelSection[] {
  const events: SectionEvent[] = [];

  const openRe = /<section\b([^>]*)>/gi;
  for (let m: RegExpExecArray | null; (m = openRe.exec(html)); ) {
    events.push({
      kind: "open",
      index: m.index,
      len: m[0].length,
      classNames: extractClassNames(m[1] ?? ""),
    });
  }

  const closeRe = /<\/section\s*>/gi;
  for (let m: RegExpExecArray | null; (m = closeRe.exec(html)); ) {
    events.push({ kind: "close", index: m.index, len: m[0].length });
  }

  events.sort((a, b) => a.index - b.index);

  const stack: SectionEvent[] = [];
  const result: TopLevelSection[] = [];

  for (const ev of events) {
    if (ev.kind === "open") {
      stack.push(ev);
    } else {
      const start = stack.pop();
      if (!start || start.kind !== "open") continue;
      // Only collect top-level sections (stack now empty).
      if (stack.length > 0) continue;
      const bodyStart = start.index + start.len;
      const bodyEnd = ev.index;
      result.push({
        openTag: html.slice(start.index, bodyStart),
        body: html.slice(bodyStart, bodyEnd),
        classNames: start.classNames,
        start: start.index,
        end: ev.index + ev.len,
      });
    }
  }

  return result;
}

function extractClassNames(attrs: string): string[] {
  const m =
    attrs.match(/\bclass\s*=\s*"([^"]*)"/i) ??
    attrs.match(/\bclass\s*=\s*'([^']*)'/i);
  if (!m) return [];
  return m[1].split(/\s+/).filter(Boolean);
}

// Block tags a slide can be wrapped in. We deliberately keep this tight — these
// are the containers Claude actually uses for slides; widening it risks slicing
// inline/flow elements into "slides".
const SLIDE_BLOCK_TAGS = "section|div|article";

/**
 * Tier 2 — the OUTERMOST elements (div/section/article) whose class list
 * contains the exact token `slide`, in document order. "Outermost" means a
 * `class="slide"` nested inside an already-matched slide is treated as that
 * slide's content, not a slide of its own — so a stray inner `.slide` badge
 * can't split a slide in two. This is the tier that rescues decks whose slides
 * are `<div class="slide">` rather than `<section class="slide">`.
 */
function walkSlideClassedElements(html: string): TopLevelSection[] {
  const result: TopLevelSection[] = [];
  const openRe = new RegExp(`<(${SLIDE_BLOCK_TAGS})\\b([^>]*)>`, "gi");
  let claimedUntil = -1;
  for (let m: RegExpExecArray | null; (m = openRe.exec(html)); ) {
    if (m.index < claimedUntil) continue; // inside a slide we already claimed
    const classNames = extractClassNames(m[2] ?? "");
    if (!classNames.includes("slide")) continue;
    const span = matchSameTagSpan(html, m[1].toLowerCase(), m.index, m[0].length);
    if (!span) continue; // unbalanced — skip rather than mis-slice
    result.push({
      openTag: html.slice(m.index, span.bodyStart),
      body: html.slice(span.bodyStart, span.bodyEnd),
      classNames,
      start: m.index,
      end: span.elementEnd,
    });
    claimedUntil = span.elementEnd;
  }
  return result;
}

/**
 * Tier 3 — last resort for decks whose slides carry no `slide` class at all.
 * We only trust this when there's an explicit slide container (`id="slides"` or
 * a class including `slides`), whose entire purpose is to hold slides, so its
 * direct element children ARE the slides. Without such a container we return
 * nothing (→ the importer fails loud) rather than guess and mis-slice nav
 * chrome, headers, or footers into slides.
 */
function walkSlidesContainerChildren(html: string): TopLevelSection[] {
  const openRe = /<(div|section|main)\b([^>]*)>/gi;
  for (let m: RegExpExecArray | null; (m = openRe.exec(html)); ) {
    const attrs = m[2] ?? "";
    const idIsSlides = /\bid\s*=\s*("|')\s*slides\s*\1/i.test(attrs);
    const classIsSlides = extractClassNames(attrs).includes("slides");
    if (!idIsSlides && !classIsSlides) continue;
    const span = matchSameTagSpan(html, m[1].toLowerCase(), m.index, m[0].length);
    if (!span) continue;
    return directChildElements(html.slice(span.bodyStart, span.bodyEnd), span.bodyStart);
  }
  return [];
}

/**
 * Direct (depth-0) block children of a container's inner HTML — used only by
 * the tier-3 fallback. A generic depth counter over div/section/article
 * open/close tags is sufficient for the well-formed HTML Claude produces; a
 * malformed close that would drive depth negative is clamped at zero.
 */
function directChildElements(inner: string, baseOffset = 0): TopLevelSection[] {
  const result: TopLevelSection[] = [];
  const tokenRe = new RegExp(
    `<(${SLIDE_BLOCK_TAGS})\\b([^>]*)>|<\\/(${SLIDE_BLOCK_TAGS})\\s*>`,
    "gi",
  );
  let depth = 0;
  let childStart = -1;
  let childBodyStart = -1;
  let childClassNames: string[] = [];
  for (let m: RegExpExecArray | null; (m = tokenRe.exec(inner)); ) {
    const isClose = m[0][1] === "/";
    if (isClose) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && childStart >= 0) {
        result.push({
          openTag: inner.slice(childStart, childBodyStart),
          body: inner.slice(childBodyStart, m.index),
          classNames: childClassNames,
          start: baseOffset + childStart,
          end: baseOffset + m.index + m[0].length,
        });
        childStart = -1;
      }
    } else {
      if (depth === 0) {
        childStart = m.index;
        childBodyStart = m.index + m[0].length;
        childClassNames = extractClassNames(m[2] ?? "");
      }
      depth += 1;
    }
  }
  return result;
}

/**
 * Given an opening tag at [openIndex, openIndex+openLen), return the element's
 * body span and end offset by depth-matching opens/closes of THAT SAME tag.
 * Returns null when the element is never closed (unbalanced markup), so callers
 * skip it instead of swallowing the rest of the document.
 */
function matchSameTagSpan(
  html: string,
  tag: string,
  openIndex: number,
  openLen: number,
): { bodyStart: number; bodyEnd: number; elementEnd: number } | null {
  const bodyStart = openIndex + openLen;
  const tokenRe = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, "gi");
  tokenRe.lastIndex = bodyStart;
  let depth = 1;
  for (let m: RegExpExecArray | null; (m = tokenRe.exec(html)); ) {
    if (m[0][1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return { bodyStart, bodyEnd: m.index, elementEnd: m.index + m[0].length };
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

// Only known-inert raster image / font types are lifted out to Storage. Active
// types (image/svg+xml can carry inline <script>, text/html is markup) are left
// inline in the slide body — harmless inside the sandboxed preview iframe and an
// <img> context — so they never become an app-origin asset URL. See
// decodeDataUrl + the asset route's serve-time neutralization.
const ASSET_MIME_ALLOWLIST = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/font-woff2",
]);
// Legacy/alias spellings collapse onto one canonical mime at decode time, so
// the canvas_deck_asset row, the storage upload contentType, and the asset
// route's serve-time Content-Type all agree on a single spelling per type.
const ASSET_MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/vnd.microsoft.icon": "image/x-icon",
  "application/font-woff": "font/woff",
  "application/font-woff2": "font/woff2",
};
// Every mime a ParsedAsset can carry (allow-list minus aliases). The `decks`
// storage bucket's allowed_mime_types must accept ALL of these or the importer
// fails the whole deck on upload — tests/db/storage-bucket-mimes.test.ts pins
// the bucket migration to this list.
export const ASSET_UPLOAD_MIMES: readonly string[] = [
  ...new Set(
    [...ASSET_MIME_ALLOWLIST].map((m) => ASSET_MIME_ALIASES[m] ?? m),
  ),
];
const MAX_ASSET_BYTES = 8 * 1024 * 1024; // per-asset decoded size cap (DoS guard)
const MAX_ASSETS = 400; // per-deck extracted-asset count cap (DoS guard)

function extractAssets(
  body: string,
  startCounter: number,
  sink: ParsedAsset[],
): { html: string; nextCounter: number } {
  let counter = startCounter;
  // We use a single regex that captures the `data:` URL anywhere inside an
  // <img> tag's src attribute. Most decks use double quotes; we also handle
  // single quotes for safety.
  const imgRe = /<img\b([^>]*?)\bsrc\s*=\s*(["'])(data:[^"']+)\2([^>]*)>/gi;
  const html = body.replace(imgRe, (_full, before, _quote, dataUrl, after) => {
    // Stop lifting once the per-deck cap is hit; decodeDataUrl additionally
    // rejects disallowed types and oversized blobs (→ null).
    const decoded = sink.length < MAX_ASSETS ? decodeDataUrl(dataUrl) : null;
    if (!decoded) {
      // Not extractable (disallowed type, too large, undecodable, or over the
      // per-deck cap) — leave the original tag inline rather than break it.
      return `<img${before}src="${dataUrl}"${after}>`;
    }
    const placeholder = assetPlaceholder(counter);
    counter += 1;
    sink.push({
      placeholder_id: placeholder,
      original_src: dataUrl,
      mime_type: decoded.mime,
      data: decoded.bytes,
    });
    return `<img${before}src="${placeholder}"${after}>`;
  });
  return { html, nextCounter: counter };
}

/**
 * Lift `url(data:…)` references out of CSS (theme_css / slide_styles) into
 * Storage assets, the CSS rewritten to placeholder tokens the importer later
 * swaps for the asset proxy URL — the CSS analogue of extractAssets's <img>
 * pass. Catches `background-image`, `background`, `border-image`, `mask`,
 * `cursor`, etc. — any `url()` value. base64 payloads contain none of `"'()`,
 * so `[^"')]+` captures the whole data URL up to its closing paren whether it's
 * quoted or bare. Non-extractable URLs (disallowed type, oversized, over the
 * per-deck cap → decodeDataUrl returns null) are left inline untouched.
 */
function extractCssAssets(
  css: string,
  startCounter: number,
  sink: ParsedAsset[],
): { css: string; nextCounter: number } {
  let counter = startCounter;
  const urlRe = /url\(\s*(["']?)(data:[^"')]+)\1\s*\)/gi;
  const out = css.replace(urlRe, (full, _quote, dataUrl) => {
    const decoded = sink.length < MAX_ASSETS ? decodeDataUrl(dataUrl) : null;
    if (!decoded) return full; // leave inline (same policy as extractAssets)
    const placeholder = assetPlaceholder(counter);
    counter += 1;
    sink.push({
      placeholder_id: placeholder,
      original_src: dataUrl,
      mime_type: decoded.mime,
      data: decoded.bytes,
    });
    return `url("${placeholder}")`;
  });
  return { css: out, nextCounter: counter };
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  // data:[<mediatype>][;base64],<data>
  // We use `[\s\S]` in the payload group instead of `.` + `/s` flag so the
  // tsconfig target (ES2017) keeps building without bumping to ES2018.
  const m = dataUrl.match(/^data:([^;,]+)?(?:;([^,]+))?,([\s\S]+)$/);
  if (!m) return null;
  const rawMime = (m[1] ?? "application/octet-stream").trim().toLowerCase();
  // Allow-list inert types only; everything else stays inline (see above).
  if (!ASSET_MIME_ALLOWLIST.has(rawMime)) return null;
  const mime = ASSET_MIME_ALIASES[rawMime] ?? rawMime;
  const params = (m[2] ?? "").toLowerCase();
  const payload = m[3];
  const isBase64 = params.split(";").some((p) => p === "base64");
  const bytes = isBase64
    ? // Whitespace-tolerant base64 decode. Buffer is available in Node + Edge.
      new Uint8Array(Buffer.from(payload.replace(/\s+/g, ""), "base64"))
    : new TextEncoder().encode(decodeURIComponent(payload));
  // Reject empty / oversized blobs (leave inline).
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) return null;
  return { mime, bytes };
}

function pickSlideTitle(body: string, classModifiers: string[]): string {
  const headings = ["h1", "h2", "h3"];
  for (const tag of headings) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = body.match(re);
    if (m) {
      const stripped = decodeEntities(stripTags(m[1])).trim();
      if (stripped) return stripped;
    }
  }
  // Look for an eyebrow / divider title.
  const eyebrow = body.match(/<div\b[^>]*class="[^"]*\beyebrow\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (eyebrow) {
    const stripped = decodeEntities(stripTags(eyebrow[1])).trim();
    if (stripped) return stripped;
  }
  // Last resort: humanise the first modifier class ("blue-slide" → "Blue slide").
  const mod = classModifiers[0];
  if (mod) return mod.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return "Untitled slide";
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/**
 * Decode the handful of HTML entities likely to appear inside extracted
 * heading text. The slide's `html_body` stays raw (iframes need real markup);
 * only the human-readable title gets decoded.
 *
 * We intentionally keep this minimal — no full HTML entity table, no DOM.
 * If we ever need broader coverage, swap in a tiny library.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_full, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_full, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // &amp; must come last — otherwise a literal `&amp;quot;` would decode in
    // two passes to `"` instead of `&quot;`.
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * The slide html_body we store is the **full <section ...>...</section>** so
 * the assembled preview is just `theme_css + slide_bodies.join('') + nav_js`.
 * Class modifiers (cover-photo, blue-slide, etc.) ride along on the open tag.
 */
function wrapSlideBody(classNames: string[], inner: string): string {
  const cls = classNames.join(" ").trim() || "slide";
  return `<section class="${escapeAttr(cls)}">${inner}</section>`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
