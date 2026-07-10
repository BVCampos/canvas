// Shared deck-export builder, used by both export routes:
//   GET /api/decks/[id]/export      → ships the HTML file itself
//   GET /api/decks/[id]/export/pdf  → renders that HTML to PDF in headless
//                                     Chromium (EXPORT_PRINT_CSS paginates it
//                                     one 1280×720 page per slide)
//
// What it does, in order:
//   1. Auth check (explicit 401 — more honest than RLS silently 404-ing).
//   2. Load deck + ordered slides under the user's RLS context.
//   3. Auto-create a `pre_export` snapshot (safety net via RPC) — exporting
//      means the deck is about to leave the building in either format.
//   4. Re-inline every /api/canvas/asset/{id} reference as a base64 data: URL
//      across ALL text surfaces (html_body, slide_styles, theme_css,
//      chrome_html — cover images usually live in theme_css) so the PDF renderer
//      never needs an authenticated fetch back into the app.
//   5. Inline web fonts (inlineFontFaces): resolve @import / preserved <link> /
//      url(...woff2) references from allowlisted font hosts into base64
//      @font-face rules. Without this the "self-contained" file still made live
//      network calls for typography — so the offline claim was only true for
//      decks that used no web fonts. Best-effort: a fetch failure leaves the
//      original reference in place. THIS is the step that makes the file (and
//      the PDF rendered from it) truly work offline.
//   6. Assemble in export mode (standalone .cv-* chrome + print stylesheet).
//
// Asset downloads use the admin client — the asset rows are scoped to a deck
// the user was just confirmed (via RLS) to read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleDeckHtml } from "@/lib/canvas/assemble";
import { logViewportShimFallback } from "@/lib/canvas/shim-fallback-log";
import {
  collectAssetIds,
  inlineAssetRefs,
  inlineFontFaces,
} from "@/lib/canvas/export-assets";
import { mapWithConcurrency } from "@/lib/async/pool";

// How many asset downloads run at once. Bounded so a logo-heavy deck isn't N
// serial Storage round-trips, but small enough that we don't open a flood of
// connections to Storage at export time. 5 is the same ceiling used elsewhere
// for fan-out against Supabase.
const ASSET_DOWNLOAD_CONCURRENCY = 5;

// The deck + slide fields the self-contained assembler needs. Both the export
// route (under user RLS) and the render_slide MCP tool (admin client scoped by
// workspace) load these same columns, so the inlining + assembly is shared.
export type SelfContainedDeck = {
  title: string;
  theme_css: string | null;
  nav_js: string | null;
  meta: Record<string, unknown> | null;
};

export type SelfContainedSlide = {
  position: number;
  title: string;
  html_body: string;
  slide_styles: string | null;
};

export type SelfContainedResult = {
  html: string;
  /** How many distinct assets were downloaded and inlined as data: URLs. */
  assetsInlined: number;
};

// Build the fully self-contained, export-mode deck HTML: every
// /api/canvas/asset/{id} reference re-inlined as a base64 data: URL across all
// text surfaces (html_body, slide_styles, theme_css, chrome_html), and web
// fonts resolved into inline @font-face rules. The result touches no
// authenticated routes, so it's safe to feed to a headless render (PDF, PPTX,
// MCP render_slide) or ship as a download.
//
// `assetClient` runs the canvas_deck_asset lookup — pass the caller's
// RLS-scoped client (export route) or an admin client already filtered to the
// workspace (MCP). Storage downloads always use the admin client (the asset
// rows were just confirmed readable by the caller).
export async function assembleSelfContainedDeck(
  deck: SelfContainedDeck,
  slideRows: SelfContainedSlide[],
  assetClient: SupabaseClient,
): Promise<SelfContainedResult> {
  const meta = (deck.meta ?? {}) as Record<string, unknown>;
  const chromeHtml = typeof meta.chrome_html === "string" ? meta.chrome_html : null;

  // Collect every asset id mentioned in any text surface the export ships.
  const assetIds = collectAssetIds([
    deck.theme_css,
    chromeHtml,
    ...slideRows.flatMap((s) => [s.html_body, s.slide_styles]),
  ]);

  // Build placeholder → data: URL map by downloading from Storage. A logo-heavy
  // deck has many assets, so we download with a BOUNDED concurrency pool rather
  // than the old strictly-sequential loop: serial round-trips made export latency
  // scale with asset count, while an unbounded Promise.all would hammer Storage.
  // The per-asset try/catch is preserved — one missing asset still logs a warn
  // and is skipped, and the resulting map is identical to the sequential one
  // (Map.set is order-independent; each entry is keyed by asset id).
  const dataUrlByAssetId = new Map<string, string>();
  if (assetIds.size > 0) {
    const admin = createAdminClient();
    const { data: assets } = await assetClient
      .from("canvas_deck_asset")
      .select("id, storage_path, mime_type")
      .in("id", Array.from(assetIds));
    await mapWithConcurrency(assets ?? [], ASSET_DOWNLOAD_CONCURRENCY, async (asset) => {
      if (!asset.storage_path) return;
      const { data: blob, error } = await admin.storage
        .from("decks")
        .download(asset.storage_path);
      if (error || !blob) {
        console.warn("[export] asset download failed", asset.id, error);
        return;
      }
      const buf = Buffer.from(await blob.arrayBuffer());
      const dataUrl = `data:${asset.mime_type || "application/octet-stream"};base64,${buf.toString("base64")}`;
      dataUrlByAssetId.set(asset.id as string, dataUrl);
    });
  }

  // Re-inline references in every surface we collected from.
  const inlinedSlides = slideRows.map((s) => ({
    position: s.position,
    title: s.title,
    html_body: inlineAssetRefs(s.html_body, dataUrlByAssetId),
    slide_styles: s.slide_styles
      ? inlineAssetRefs(s.slide_styles, dataUrlByAssetId)
      : s.slide_styles,
  }));

  const inlinedThemeCss = inlineAssetRefs(deck.theme_css ?? "", dataUrlByAssetId);
  const inlinedMeta: Record<string, unknown> = chromeHtml
    ? { ...meta, chrome_html: inlineAssetRefs(chromeHtml, dataUrlByAssetId) }
    : { ...meta };

  // Make web fonts self-contained too. The asset pass above only touched
  // /api/canvas/asset references; this resolves @import / <link> / url(...woff2)
  // font references (allowlisted hosts only, best-effort) into inline base64
  // @font-face rules so the exported HTML — and the PDF rendered from it — never
  // reaches the network for typography. We then re-point meta.font_links at only
  // the links we COULDN'T inline, so assemble.ts emits live <link> tags as a
  // fallback for those rather than for fonts we just embedded. slide_styles are
  // passed as extra surfaces so a slide-scoped @import/@font-face is inlined too
  // — otherwise it stays a live font fetch that stalls the headless render.
  const fontLinks = Array.isArray(inlinedMeta.font_links)
    ? (inlinedMeta.font_links as unknown[]).filter(
        (h): h is string => typeof h === "string",
      )
    : [];
  const slideStyleSurfaces = inlinedSlides.map((s) => s.slide_styles ?? "");
  const {
    themeCss: themedThemeCss,
    fontFaceCss,
    unresolvedFontLinks,
    extraCss: fontInlinedSlideStyles,
  } = await inlineFontFaces(inlinedThemeCss, fontLinks, undefined, slideStyleSurfaces);
  inlinedMeta.font_links = unresolvedFontLinks;
  // Fold the font-inlined slide_styles back in (null stays null; a slide that had
  // styles gets its rewritten version, same order as slideStyleSurfaces).
  for (let i = 0; i < inlinedSlides.length; i++) {
    if (inlinedSlides[i].slide_styles != null) {
      inlinedSlides[i].slide_styles = fontInlinedSlideStyles[i];
    }
  }

  // The resolved @font-face rules ride at the END of theme_css so each face is
  // defined before the deck's font-family rules reference it. assemble.ts wraps
  // theme_css in the head <style>, so we fold in the raw CSS (not a <style> tag).
  const themeWithFonts = fontFaceCss
    ? `${themedThemeCss}\n\n${fontFaceCss}`
    : themedThemeCss;

  const html = assembleDeckHtml({
    title: deck.title,
    theme_css: themeWithFonts,
    nav_js: deck.nav_js ?? "",
    meta: inlinedMeta,
    slides: inlinedSlides,
    mode: "export",
  });

  return { html, assetsInlined: dataUrlByAssetId.size };
}

export type DeckExportSuccess = {
  ok: true;
  html: string;
  title: string;
  userId: string;
  workspaceId: string;
  slideCount: number;
  assetsInlined: number;
  /**
   * Ordered slide titles (Canvas internal labels — frequently empty). The PPTX
   * export names each PowerPoint slide after its Canvas slide; positional
   * fallback ("Slide N") is the route's job when a title is blank.
   */
  slideTitles: string[];
  /**
   * Ordered speaker notes (0067) — the presenter talk track, null when a
   * slide has none. The PPTX export carries them into PowerPoint's notes
   * field so the talk track travels with the deliverable.
   */
  slideNotes: (string | null)[];
};

export type DeckExportFailure = {
  ok: false;
  status: 401 | 404 | 500;
  message: string;
};

export type DeckExportResult = DeckExportSuccess | DeckExportFailure;

export async function buildDeckExportHtml(
  id: string,
  options: {
    /**
     * Mint the pre_export safety snapshot when the deck changed (default).
     * Pre-flight passes false: CHECKING a deck must not create restore
     * points or History noise.
     */
    snapshot?: boolean;
  } = {},
): Promise<DeckExportResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, message: "Unauthorized" };

  const { data: deck, error: deckErr } = await supabase
    .from("canvas_deck")
    .select("id, title, theme_css, nav_js, meta, workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (deckErr) {
    console.error("[export]", deckErr);
    return { ok: false, status: 500, message: "Lookup failed" };
  }
  if (!deck) return { ok: false, status: 404, message: "Not found" };

  const { data: slides } = await supabase
    .from("canvas_deck_slide")
    .select("position, title, html_body, slide_styles, speaker_notes, current_version_id")
    .eq("deck_id", id)
    .order("position", { ascending: true });

  const slideRows = slides ?? [];

  // Snapshot before we ship the file — gives the team a one-click undo if
  // somebody catches a mistake post-send. BUT skip it when the deck is
  // byte-identical to its most recent snapshot: re-downloading an unchanged
  // deck (HTML then PDF, or a second export after no edit) would otherwise mint
  // a stack of identical snapshots and bury the real restore points in History.
  if (
    options.snapshot !== false &&
    (await deckChangedSinceLatestSnapshot(supabase, id, deck.theme_css ?? "", deck.nav_js ?? "", slideRows))
  ) {
    await supabase.rpc("canvas_create_snapshot", {
      _deck_id: id,
      _label: `Pre-export ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      _description: null,
      _kind: "pre_export",
    });
  }

  // Signal when this export lands on the squeeze fallback that scrambles
  // fixed-px decks (fires only on that path; see logViewportShimFallback).
  // Reads raw theme/nav — asset/font inlining doesn't touch the `.slide` size
  // rules or `--slide-zoom` the gate keys off.
  logViewportShimFallback({
    theme_css: deck.theme_css ?? "",
    nav_js: deck.nav_js ?? "",
    surface: "api",
    deck_id: id,
    user_id: user.id,
    workspace_id: deck.workspace_id as string,
  });

  // Asset re-inlining, font inlining, and export-mode assembly are shared with
  // the render_slide MCP tool (assembleSelfContainedDeck). The asset lookup runs
  // under the caller's RLS client — the rows are scoped to a deck the user was
  // just confirmed to read.
  const { html, assetsInlined } = await assembleSelfContainedDeck(
    {
      title: deck.title,
      theme_css: deck.theme_css,
      nav_js: deck.nav_js,
      meta: deck.meta as Record<string, unknown> | null,
    },
    slideRows.map((s) => ({
      position: s.position as number,
      title: (s.title as string | null) ?? "",
      html_body: s.html_body as string,
      slide_styles: (s.slide_styles as string | null) ?? null,
    })),
    supabase,
  );

  return {
    ok: true,
    html,
    title: deck.title,
    userId: user.id,
    workspaceId: deck.workspace_id as string,
    slideCount: slideRows.length,
    assetsInlined,
    slideTitles: slideRows.map((s) => (s.title as string | null) ?? ""),
    slideNotes: slideRows.map(
      (s) => ((s as { speaker_notes?: string | null }).speaker_notes ?? null),
    ),
  };
}

// True if the deck's current state differs from its most recent snapshot (so a
// fresh pre_export snapshot is worth taking). False when they're byte-identical
// — comparing theme/nav plus the (position → current_version_id) map against the
// snapshot's (position → slide_version_id) map. A deck that has never been
// snapshotted always returns true. Read under the caller's RLS (members can read
// snapshots + snapshot slides).
type SnapshotDedupClient = Awaited<ReturnType<typeof createClient>>;
type SlidePointer = { position: number; current_version_id: string | null };

async function deckChangedSinceLatestSnapshot(
  supabase: SnapshotDedupClient,
  deckId: string,
  themeCss: string,
  navJs: string,
  slideRows: SlidePointer[],
): Promise<boolean> {
  const { data: snap } = await supabase
    .from("canvas_deck_snapshot")
    .select("id, theme_css, nav_js")
    .eq("deck_id", deckId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Never snapshotted, or theme/nav drifted → definitely changed.
  if (!snap) return true;
  if ((snap.theme_css ?? "") !== themeCss || (snap.nav_js ?? "") !== navJs) return true;

  const { data: snapSlides } = await supabase
    .from("canvas_deck_snapshot_slide")
    .select("position, slide_version_id")
    .eq("snapshot_id", snap.id);

  const snapMap = new Map<number, string>();
  for (const r of snapSlides ?? []) {
    snapMap.set(r.position as number, r.slide_version_id as string);
  }

  // Different slide count, or any position pointing at a different version →
  // changed. (A null current_version_id can never equal a snapshot pointer.)
  if (snapMap.size !== slideRows.length) return true;
  for (const s of slideRows) {
    if (snapMap.get(s.position) !== s.current_version_id) return true;
  }
  return false;
}

export function sanitizeFilename(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^\w\s.-]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80) || "deck"
  );
}
