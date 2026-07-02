// Asset re-inlining for "Export HTML" — the half of the export route that
// turns authenticated `/api/canvas/asset/{id}` references into base64 data:
// URLs so the downloaded file works offline.
//
// Asset references are not confined to slide bodies: a cover slide's
// background-image typically lives in the deck's theme_css
// (`.capa-bg{background-image:url("/api/canvas/asset/…")}`), and per-slide
// styles or body chrome (meta.chrome_html) can reference assets the same way.
// The export must therefore scan and rewrite EVERY text surface it ships,
// not just html_body — exporting only the bodies is how cover images went
// missing from exported decks.

export const ASSET_URL_RE =
  /\/api\/canvas\/asset\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

// Web-font inlining — the other half of "works offline". The asset pass above
// only covers `/api/canvas/asset/{uuid}` references; a deck's typography lives
// elsewhere: a theme_css `@import url(https://fonts.googleapis.com/...)`, a
// preserved `<link rel="stylesheet">` font href (meta.font_links), or a raw
// `url(...woff2)` inside an @font-face. All three stay LIVE network calls in
// the exported file unless we resolve them here — so a font-driven deck's
// "offline" HTML silently re-fetched its fonts (and the PDF renderer, which
// prints that HTML, hit the network mid-render). inlineFontFaces fetches the
// font CSS + each binary it names and embeds them as base64 @font-face rules.
//
// SSRF safety: we only ever fetch from FONT_HOST_ALLOWLIST. This list is a copy
// of the parser's (the two server modules stay independent); keep them in sync.
// Anything off the allowlist is left exactly as-is, untouched.
const FONT_HOST_ALLOWLIST = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
];

function isAllowlistedFontHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return FONT_HOST_ALLOWLIST.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

// Map a font-binary URL's extension to the data: MIME woff2/woff/ttf/otf want.
// The format the @font-face `src` declares (woff2 / woff / truetype / opentype)
// drives which the browser actually loads, so the data: MIME only needs to be
// font-shaped; we pick the precise one anyway for correctness.
function fontMimeForUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".otf")) return "font/otf";
  if (path.endsWith(".eot")) return "application/vnd.ms-fontobject";
  return "font/woff2";
}

// Matches a font-binary `url(...)` inside CSS: a quoted-or-bare URL ending in a
// known font extension (optionally with ?query / #frag), capturing the URL. We
// scope to font extensions so we never try to fetch a `url(image.png)` or a
// `data:` URL that already lives inline. base64/data and `"'()` can't appear in
// a bare web URL, so `[^"')]+` captures cleanly to the closing paren.
const FONT_URL_RE =
  /url\(\s*(["']?)((?:https?:)?\/\/[^"')]+?\.(?:woff2|woff|ttf|otf|eot)(?:[?#][^"')]*)?)\1\s*\)/gi;

// A bare `@import url(...)` / `@import "..."` at the top of a CSS file — the
// most common way a deck pulls in Google Fonts from theme_css.
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)\s*;/gi;

type FetchLike = typeof fetch;

/**
 * Resolve a font URL to a base64 `data:` URL via an allowlisted fetch, memoised
 * in `cache` for the lifetime of one export. Best-effort: any failure (off
 * allowlist, network error, non-2xx, empty body) returns null and the caller
 * leaves the original reference in place. Never throws.
 */
async function fetchAsDataUrl(
  url: string,
  cache: Map<string, string | null>,
  fetchImpl: FetchLike,
): Promise<string | null> {
  if (cache.has(url)) return cache.get(url) ?? null;
  let result: string | null = null;
  try {
    if (!isAllowlistedFontHost(url)) {
      cache.set(url, null);
      return null;
    }
    const res = await fetchImpl(url);
    if (!res.ok) {
      console.warn("[export] font fetch non-ok", url, res.status);
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0) {
        result = `data:${fontMimeForUrl(url)};base64,${buf.toString("base64")}`;
      }
    }
  } catch (err) {
    console.warn("[export] font fetch failed", url, err);
  }
  cache.set(url, result);
  return result;
}

/**
 * Fetch one font-CSS stylesheet (e.g. a Google Fonts `css2?family=…` URL),
 * inline every font-binary `url(...)` inside it as a base64 data: URL, and
 * return the rewritten CSS. The protocol-relative `//host/...` form Google
 * sometimes emits is normalised to https for the fetch. Best-effort per binary:
 * a font that fails to download is left as its original URL (a live ref beats a
 * broken file). Returns null when the stylesheet itself can't be fetched.
 */
async function inlineFontStylesheet(
  cssUrl: string,
  cssCache: Map<string, string | null>,
  binaryCache: Map<string, string | null>,
  fetchImpl: FetchLike,
): Promise<string | null> {
  // A stylesheet can be referenced by both a <link> and an @import in the same
  // deck; resolve (fetch + inline its binaries) once per URL per export.
  if (cssCache.has(cssUrl)) return cssCache.get(cssUrl) ?? null;
  let css: string;
  try {
    if (!isAllowlistedFontHost(cssUrl)) {
      cssCache.set(cssUrl, null);
      return null;
    }
    const res = await fetchImpl(cssUrl);
    if (!res.ok) {
      console.warn("[export] font css non-ok", cssUrl, res.status);
      cssCache.set(cssUrl, null);
      return null;
    }
    css = await res.text();
  } catch (err) {
    console.warn("[export] font css fetch failed", cssUrl, err);
    cssCache.set(cssUrl, null);
    return null;
  }
  const resolved = await rewriteFontUrls(css, binaryCache, fetchImpl);
  cssCache.set(cssUrl, resolved);
  return resolved;
}

/** Replace every font-binary `url(...)` in `css` with its data: URL (best-effort). */
async function rewriteFontUrls(
  css: string,
  cache: Map<string, string | null>,
  fetchImpl: FetchLike,
): Promise<string> {
  const jobs: Array<{ match: string; url: string }> = [];
  for (const m of css.matchAll(FONT_URL_RE)) {
    const url = normaliseProtocol(m[2]);
    jobs.push({ match: m[0], url });
  }
  // Dedupe URLs (a face often lists the same binary twice); fetch each once.
  const dataUrlByUrl = new Map<string, string | null>();
  for (const { url } of jobs) {
    if (!dataUrlByUrl.has(url)) {
      dataUrlByUrl.set(url, await fetchAsDataUrl(url, cache, fetchImpl));
    }
  }
  let out = css;
  for (const { match, url } of jobs) {
    const dataUrl = dataUrlByUrl.get(url);
    if (!dataUrl) continue; // leave the original url() in place
    // Rebuild the url() with the data URL; quote it so the long base64 (which
    // contains no quotes) parses cleanly.
    out = out.replace(match, `url("${dataUrl}")`);
  }
  return out;
}

// `//fonts.gstatic.com/...` → `https://fonts.gstatic.com/...` for fetching.
function normaliseProtocol(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

export type FontInlineResult = {
  /** `theme_css` with any `@import` of an allowlisted font stylesheet inlined. */
  themeCss: string;
  /**
   * Resolved `@font-face` CSS (base64 data: URLs), or "" when nothing was
   * inlined. NOT wrapped in a <style> tag — the caller folds it into theme_css,
   * which assemble.ts already wraps in the head <style>. The caller also drops
   * the now-embedded entries from meta.font_links so assemble.ts won't ALSO emit
   * live <link> tags for fonts we just embedded.
   */
  fontFaceCss: string;
  /** font_links that could NOT be inlined — keep these as live <link> tags. */
  unresolvedFontLinks: string[];
  /**
   * The `extraCssSurfaces` passed in (e.g. each slide's slide_styles), each with
   * its own `@import`s inlined and raw font url()s rewritten in place — same
   * order as the input. Empty when no extra surfaces were passed. Sharing this
   * pass with theme_css means a slide-scoped @font-face no longer leaks a live
   * font fetch at render time either.
   */
  extraCss: string[];
};

// Inline the font references inside ONE css surface (theme_css, or a slide's
// slide_styles): fetch + strip any `@import` of an allowlisted font stylesheet
// (its resolved @font-face rules come back in `faceBlocks`, which the caller
// folds into the global theme <style>), and rewrite raw font-binary url(...)
// refs in place. The caches + emittedStylesheets set are shared across every
// surface in one call so a stylesheet or binary is fetched at most once per
// assembly. Best-effort: any fetch failure leaves that reference untouched.
async function inlineFontsInCssSurface(
  cssIn: string,
  cssCache: Map<string, string | null>,
  binaryCache: Map<string, string | null>,
  emittedStylesheets: Set<string>,
  fetchImpl: FetchLike,
): Promise<{ css: string; faceBlocks: string[] }> {
  const faceBlocks: string[] = [];
  let css = cssIn;
  const imports: Array<{ match: string; url: string }> = [];
  for (const m of cssIn.matchAll(CSS_IMPORT_RE)) {
    imports.push({ match: m[0], url: normaliseProtocol(m[2] ?? m[4]) });
  }
  for (const { match, url } of imports) {
    if (!isAllowlistedFontHost(url)) continue; // off allowlist → leave the @import
    const inlined = await inlineFontStylesheet(url, cssCache, binaryCache, fetchImpl);
    if (!inlined) continue; // fetch failed → leave the @import live
    // Emit the resolved face once even if a <link> (or another surface) already
    // covered this URL, but always strip the redundant @import from this surface.
    if (!emittedStylesheets.has(url)) {
      faceBlocks.push(inlined);
      emittedStylesheets.add(url);
    }
    css = css.replace(match, "");
  }
  // Raw font-binary url(...) already inside this surface (a surface that shipped
  // its own @font-face) → inline the binary in place.
  css = await rewriteFontUrls(css, binaryCache, fetchImpl);
  return { css, faceBlocks };
}

/**
 * Make a deck's web fonts self-contained for export. Resolves three reference
 * shapes, all gated on FONT_HOST_ALLOWLIST and all best-effort:
 *   1. `<link rel="stylesheet">` font hrefs (preserved into meta.font_links at
 *      import) → fetch the CSS, inline its binaries, emit the @font-face rules.
 *   2. `@import url(...)` of an allowlisted font CSS inside theme_css (or any
 *      `extraCssSurfaces`) → same, rewriting the @import out so it isn't a live call.
 *   3. raw `url(...woff2|woff|ttf|otf)` already inside theme_css / an extra
 *      surface (something that shipped its own @font-face) → inline in place.
 * Pass `extraCssSurfaces` (e.g. each slide's slide_styles) to inline slide-scoped
 * fonts too — otherwise a slide's own @import stays a LIVE network call at render
 * time, which an unbounded document.fonts.ready then hangs on. They come back in
 * `extraCss` (same order), sharing the fetch caches with the theme pass.
 * Caches every fetched URL for the call so a CSS or binary is never fetched
 * twice. Never throws: a fetch failure leaves that reference untouched.
 */
export async function inlineFontFaces(
  themeCss: string,
  fontLinks: string[],
  fetchImpl: FetchLike = fetch,
  extraCssSurfaces: string[] = [],
): Promise<FontInlineResult> {
  const cssCache = new Map<string, string | null>(); // stylesheet URL → inlined CSS
  const binaryCache = new Map<string, string | null>(); // binary URL → data: URL
  const fontFaceBlocks: string[] = [];
  const emittedStylesheets = new Set<string>(); // URLs already in fontFaceBlocks
  const unresolvedFontLinks: string[] = [];

  // (1) Preserved <link> stylesheets.
  for (const href of fontLinks) {
    const url = normaliseProtocol(href);
    const inlined = await inlineFontStylesheet(url, cssCache, binaryCache, fetchImpl);
    if (inlined) {
      if (!emittedStylesheets.has(url)) {
        fontFaceBlocks.push(inlined);
        emittedStylesheets.add(url);
      }
    } else {
      unresolvedFontLinks.push(href); // keep the live <link> as a fallback
    }
  }

  // (2)+(3) theme_css: strip/inline its @imports and raw font url()s.
  const theme = await inlineFontsInCssSurface(
    themeCss,
    cssCache,
    binaryCache,
    emittedStylesheets,
    fetchImpl,
  );
  fontFaceBlocks.push(...theme.faceBlocks);

  // (2)+(3) again for every extra surface (slide_styles), sharing the caches so a
  // font referenced by both theme and a slide is fetched once.
  const extraCss: string[] = [];
  for (const surface of extraCssSurfaces) {
    const r = await inlineFontsInCssSurface(
      surface,
      cssCache,
      binaryCache,
      emittedStylesheets,
      fetchImpl,
    );
    fontFaceBlocks.push(...r.faceBlocks);
    extraCss.push(r.css);
  }

  // Mark the inlined block so a reviewer reading the exported file can find the
  // embedded faces. A CSS comment is valid inside the head <style> the caller
  // folds this into (a <style> tag would not be).
  const fontFaceCss =
    fontFaceBlocks.length > 0
      ? `/* canvas: inlined web fonts */\n${fontFaceBlocks.join("\n")}`
      : "";

  return { themeCss: theme.css, fontFaceCss, unresolvedFontLinks, extraCss };
}

/** Collect the deduped, lowercased asset ids referenced by any of `texts`. */
export function collectAssetIds(texts: Array<string | null | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(ASSET_URL_RE)) {
      ids.add(m[1].toLowerCase());
    }
  }
  return ids;
}

/**
 * Replace every asset reference in `text` with its data: URL. References
 * whose asset could not be downloaded are left untouched (same behavior the
 * route always had: a broken image beats a corrupted file).
 */
export function inlineAssetRefs(
  text: string,
  dataUrlByAssetId: Map<string, string>,
): string {
  return text.replace(ASSET_URL_RE, (full, idRaw: string) => {
    return dataUrlByAssetId.get(idRaw.toLowerCase()) ?? full;
  });
}
