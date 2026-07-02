import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAssetIds,
  inlineAssetRefs,
  inlineFontFaces,
} from "../src/lib/canvas/export-assets";

const ID_A = "c5e74b9d-b3a8-4b2b-8e12-e36ffab49598";
const ID_B = "0f3a1d22-9c4e-4b1a-8d5f-1234567890ab";

describe("collectAssetIds", () => {
  it("finds references across html, slide styles, theme css and chrome html", () => {
    const html = `<section class="slide"><img src="/api/canvas/asset/${ID_A}" /></section>`;
    const themeCss = `.capa-bg{background-image:url("/api/canvas/asset/${ID_B}");background-size:cover;}`;
    const ids = collectAssetIds([html, themeCss]);
    expect(ids).toEqual(new Set([ID_A, ID_B]));
  });

  it("dedupes repeated references and lowercases ids", () => {
    const upper = ID_A.toUpperCase();
    const ids = collectAssetIds([
      `url(/api/canvas/asset/${upper})`,
      `<img src="/api/canvas/asset/${ID_A}">`,
    ]);
    expect(ids).toEqual(new Set([ID_A]));
  });

  it("skips null and empty surfaces", () => {
    expect(collectAssetIds([null, undefined, ""])).toEqual(new Set());
  });
});

describe("inlineAssetRefs", () => {
  const dataUrls = new Map([[ID_A, "data:image/png;base64,AAAA"]]);

  it("rewrites a background-image url in theme css", () => {
    const css = `.capa-bg{background-image:url("/api/canvas/asset/${ID_A}");}`;
    const out = inlineAssetRefs(css, dataUrls);
    expect(out).toBe(`.capa-bg{background-image:url("data:image/png;base64,AAAA");}`);
  });

  it("rewrites an <img> src in html", () => {
    const html = `<img src="/api/canvas/asset/${ID_A}" alt="capa">`;
    expect(inlineAssetRefs(html, dataUrls)).toBe(
      `<img src="data:image/png;base64,AAAA" alt="capa">`,
    );
  });

  it("leaves references untouched when the asset is missing from the map", () => {
    const html = `<img src="/api/canvas/asset/${ID_B}">`;
    expect(inlineAssetRefs(html, dataUrls)).toBe(html);
  });

  it("matches ids case-insensitively", () => {
    const html = `<img src="/api/canvas/asset/${ID_A.toUpperCase()}">`;
    expect(inlineAssetRefs(html, dataUrls)).toContain("data:image/png;base64,AAAA");
  });
});

// inlineFontFaces makes a deck's web fonts self-contained for export: it
// resolves @import / preserved-<link> / url(...woff2) references on allowlisted
// hosts into base64 @font-face rules. We mock fetch (no real network) and prove
// the rewrite happens, the allowlist holds, and any failure degrades safely.
describe("inlineFontFaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const WOFF2_URL = "https://fonts.gstatic.com/s/inter/v1/inter.woff2";
  const CSS_URL = "https://fonts.googleapis.com/css2?family=Inter";
  // A Google-Fonts-shaped stylesheet: an @font-face whose src points at a woff2.
  const FONT_CSS = `@font-face{font-family:'Inter';font-style:normal;src:url(${WOFF2_URL}) format('woff2');}`;

  // Build a fetch double that serves known CSS / binary URLs and 404s the rest.
  // `font binary` bytes are arbitrary; we only assert they end up base64'd.
  function mockFetch(routes: Record<string, { css?: string; bytes?: string; status?: number }>) {
    return vi.fn(async (url: string | URL) => {
      const key = String(url);
      const route = routes[key];
      if (!route || route.status === 404) {
        return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (route.css !== undefined) {
        return { ok: true, status: 200, text: async () => route.css!, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const buf = Buffer.from(route.bytes ?? "FONTBYTES");
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }) as unknown as typeof fetch;
  }

  it("inlines a preserved <link> font stylesheet into base64 @font-face rules", async () => {
    const fetchImpl = mockFetch({
      [CSS_URL]: { css: FONT_CSS },
      [WOFF2_URL]: { bytes: "FONTBYTES" },
    });
    const result = await inlineFontFaces("", [CSS_URL], fetchImpl);
    // The font binary became a data: URL inside an @font-face rule.
    expect(result.fontFaceCss).toContain("@font-face");
    expect(result.fontFaceCss).toContain("data:font/woff2;base64,");
    // The live network URL is gone from the inlined CSS.
    expect(result.fontFaceCss).not.toContain(WOFF2_URL);
    // Fully resolved → nothing left to emit as a live <link>.
    expect(result.unresolvedFontLinks).toEqual([]);
  });

  it("inlines an @import of an allowlisted font stylesheet and removes the @import", async () => {
    const theme = `@import url(${CSS_URL});\n.cover{font-family:'Inter'}`;
    const fetchImpl = mockFetch({
      [CSS_URL]: { css: FONT_CSS },
      [WOFF2_URL]: { bytes: "X" },
    });
    const result = await inlineFontFaces(theme, [], fetchImpl);
    // @import is gone from theme_css (no longer a live call) ...
    expect(result.themeCss).not.toContain("@import");
    // ... and the resolved face is emitted with a data: URL.
    expect(result.fontFaceCss).toContain("data:font/woff2;base64,");
  });

  it("inlines a raw url(...woff2) already inside theme_css", async () => {
    const theme = `@font-face{font-family:'X';src:url("${WOFF2_URL}") format('woff2')}`;
    const fetchImpl = mockFetch({ [WOFF2_URL]: { bytes: "Y" } });
    const result = await inlineFontFaces(theme, [], fetchImpl);
    expect(result.themeCss).toContain("data:font/woff2;base64,");
    expect(result.themeCss).not.toContain(WOFF2_URL);
  });

  it("leaves a NON-allowlisted host completely untouched (SSRF guard)", async () => {
    const evilCss = "https://evil.example.com/font.css";
    const evilWoff = "https://evil.example.com/font.woff2";
    const theme = `@import url(${evilCss});\n.x{src:url(${evilWoff})}`;
    // fetch must never be called for off-allowlist hosts.
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch should not be called for non-allowlisted hosts");
    }) as unknown as typeof fetch;
    const result = await inlineFontFaces(theme, [evilCss], fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The @import and the url() survive verbatim; the link stays unresolved.
    expect(result.themeCss).toContain(evilCss);
    expect(result.themeCss).toContain(evilWoff);
    expect(result.fontFaceCss).toBe("");
    expect(result.unresolvedFontLinks).toEqual([evilCss]);
  });

  it("degrades safely when the stylesheet fetch fails — keeps the <link> as unresolved, never throws", async () => {
    const fetchImpl = mockFetch({ [CSS_URL]: { status: 404 } });
    const result = await inlineFontFaces("", [CSS_URL], fetchImpl);
    expect(result.fontFaceCss).toBe("");
    expect(result.unresolvedFontLinks).toEqual([CSS_URL]);
  });

  it("leaves the original url() in place when a font binary fetch fails", async () => {
    // CSS resolves but the binary 404s — the @font-face keeps its live URL
    // (a live ref beats a broken file).
    const fetchImpl = mockFetch({
      [CSS_URL]: { css: FONT_CSS },
      [WOFF2_URL]: { status: 404 },
    });
    const result = await inlineFontFaces("", [CSS_URL], fetchImpl);
    expect(result.fontFaceCss).toContain(WOFF2_URL);
    expect(result.fontFaceCss).not.toContain("data:font/woff2;base64,");
  });

  it("fetches each URL only once within a single export (cache)", async () => {
    // Same stylesheet referenced twice (a <link> AND an @import); the CSS and
    // its binary must each be fetched once.
    const fetchImpl = mockFetch({
      [CSS_URL]: { css: FONT_CSS },
      [WOFF2_URL]: { bytes: "Z" },
    });
    await inlineFontFaces(`@import url(${CSS_URL});`, [CSS_URL], fetchImpl);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u === CSS_URL)).toHaveLength(1);
    expect(calls.filter((u) => u === WOFF2_URL)).toHaveLength(1);
  });

  it("uses the global fetch when no fetchImpl is passed (vi.stubGlobal)", async () => {
    const stub = vi.fn(async (url: string | URL) => {
      const key = String(url);
      if (key === CSS_URL) return { ok: true, status: 200, text: async () => FONT_CSS, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => Buffer.from("G").buffer };
    });
    vi.stubGlobal("fetch", stub);
    const result = await inlineFontFaces("", [CSS_URL]);
    expect(stub).toHaveBeenCalled();
    expect(result.fontFaceCss).toContain("data:font/woff2;base64,");
  });

  it("returns empty results for a deck with no fonts at all", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await inlineFontFaces(".plain{color:red}", [], fetchImpl);
    expect(result).toEqual({
      themeCss: ".plain{color:red}",
      fontFaceCss: "",
      unresolvedFontLinks: [],
      extraCss: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("inlines a raw url(...woff2) in an extra surface (a slide's slide_styles)", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url === WOFF2_URL) return new Response(new Uint8Array([1, 2, 3, 4]));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    // No fonts in theme_css; the font lives in the slide's own @font-face.
    const slideStyles = `@font-face{font-family:X;src:url(${WOFF2_URL}) format("woff2")}`;
    const result = await inlineFontFaces("", [], stub, [slideStyles]);
    expect(result.extraCss).toHaveLength(1);
    expect(result.extraCss[0]).toContain("data:font/woff2;base64,");
    expect(result.extraCss[0]).not.toContain(WOFF2_URL);
    // theme_css untouched; the face was rewritten in place in the surface.
    expect(result.themeCss).toBe("");
  });

  it("pulls a slide_styles @import out into a shared @font-face block", async () => {
    const stub = vi.fn(async (url: string) => {
      if (url === CSS_URL) {
        return new Response(`@font-face{font-family:Y;src:url(${WOFF2_URL}) format("woff2")}`);
      }
      if (url === WOFF2_URL) return new Response(new Uint8Array([5, 6, 7, 8]));
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const slideStyles = `@import url(${CSS_URL});.t{color:blue}`;
    const result = await inlineFontFaces("", [], stub, [slideStyles]);
    // @import stripped from the surface, face inlined into the global block.
    expect(result.extraCss[0]).not.toContain("@import");
    expect(result.extraCss[0]).toContain(".t{color:blue}");
    expect(result.fontFaceCss).toContain("data:font/woff2;base64,");
  });
});
