// Importer — phase 1.
//
// Takes a parsed deck (from `parser.ts`) plus a workspace + user context and
// commits it to Postgres + Storage. Designed to be called from a Server Action
// or API route; never imported in a client component.
//
// Workflow:
//   1. INSERT canvas_deck row (theme_css, nav_js, meta, title, created_by)
//   2. For each parsed asset (deduped by content hash — decks often embed the
//      same logo on every slide as separate data: URLs; minting one asset per
//      occurrence triples storage and triples the base64 weight of every
//      later "Export HTML"):
//        a. INSERT canvas_deck_asset row to mint a stable id
//        b. Upload bytes to Storage at {workspace_id}/{deck_id}/{asset_id}.{ext}
//        c. UPDATE the asset row with the real storage_path
//        d. Build a placeholder→public-url map
//   3. Rewrite each slide's html_body, substituting placeholders with
//      `/api/canvas/asset/{asset_id}` URLs
//   4. INSERT canvas_deck_slide rows in order. The 0002 trigger auto-creates
//      version_no=1 for each, pointing canvas_deck_slide.current_version_id
//      at it.
//
// Errors at any step abort and clean up best-effort (delete the deck row if it
// was created — cascades take care of slides / assets / versions).

import { createHash } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseDeckHtml,
  rewriteAssetPlaceholders,
  type ParsedDeck,
} from "@/lib/canvas/parser";
import { stripEditorHints } from "@/lib/canvas/strip-hints";

export type ImportOptions = {
  workspace_id: string;
  user_id: string;
  /** Override the deck title (otherwise the parser's <title> is used). */
  title?: string;
  /**
   * Optional soft-link to a 21x-workforce-management Client / Proposal. Plain
   * UUIDs (no FK enforcement); workforce-management can resolve them, Canvas
   * just stores them. Both default to null in the standalone world (ADR-0004).
   */
  client_id?: string | null;
  proposal_id?: string | null;
  /**
   * Optional Canvas Project (canvas_project.id) the deck is created inside.
   * Callers must validate the project belongs to `workspace_id` first — the
   * importer writes via the admin client, so RLS won't catch a mismatch.
   */
  project_id?: string | null;
  /**
   * Per-deck visibility. 'workspace' (default) is the legacy behaviour where
   * every workspace member can read the deck. 'private' restricts reads to
   * explicit canvas_deck_member entries plus workspace admins; the DB trigger
   * auto-adds the creator as an editor so the deck is reachable on first load.
   */
  visibility?: "workspace" | "private";
};

export type ImportResult = {
  deck_id: string;
  slide_count: number;
  asset_count: number;
};

/** Convenience wrapper that parses + imports in one call. */
export async function importDeckFromHtml(
  html: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  const parsed = parseDeckHtml(html);
  return importParsedDeck(parsed, opts);
}

/** Commits a pre-parsed deck. Exposed so tests can feed synthetic ParsedDeck. */
export async function importParsedDeck(
  parsed: ParsedDeck,
  opts: ImportOptions,
): Promise<ImportResult> {
  const deckTitle = opts.title?.trim() || parsed.title;
  if (parsed.slides.length === 0) {
    throw new Error(
      "importDeck: no slides found — expected at least one <section class=\"slide\">",
    );
  }

  const admin = createAdminClient();

  // 1. Create the deck row.
  const { data: deckRow, error: deckErr } = await admin
    .from("canvas_deck")
    .insert({
      workspace_id: opts.workspace_id,
      client_id: opts.client_id ?? null,
      proposal_id: opts.proposal_id ?? null,
      project_id: opts.project_id ?? null,
      title: deckTitle,
      theme_css: parsed.theme_css,
      nav_js: parsed.nav_js,
      meta: {
        lang: parsed.lang,
        ...parsed.meta,
        // Non-slide body chrome (modal overlays, dots rails) the deck's nav_js
        // addresses by id — assembleDeckHtml re-injects it. See parser.ts.
        ...(parsed.chrome_html ? { chrome_html: parsed.chrome_html } : {}),
      },
      created_by: opts.user_id,
      visibility: opts.visibility ?? "workspace",
    })
    .select("id")
    .single();

  if (deckErr || !deckRow) {
    throw new Error(`importDeck: failed to insert deck — ${deckErr?.message ?? "unknown error"}`);
  }
  const deck_id = deckRow.id as string;

  try {
    // 2. Mint asset rows + upload bytes. Byte-identical payloads (same image
    //    embedded on several slides) collapse onto one asset: every duplicate
    //    placeholder points at the first occurrence's URL.
    const placeholderToUrl = new Map<string, string>();
    const urlByContentHash = new Map<string, string>();
    let minted_assets = 0;

    for (const asset of parsed.assets) {
      const contentHash = createHash("sha256").update(asset.data).digest("hex");
      const existingUrl = urlByContentHash.get(contentHash);
      if (existingUrl) {
        placeholderToUrl.set(asset.placeholder_id, existingUrl);
        continue;
      }

      const { data: assetRow, error: assetErr } = await admin
        .from("canvas_deck_asset")
        .insert({
          workspace_id: opts.workspace_id,
          deck_id,
          storage_path: "", // overwritten below once we know the path
          mime_type: asset.mime_type,
          size_bytes: asset.data.byteLength,
          original_src: asset.original_src.slice(0, 200), // truncate; we only keep enough to debug
        })
        .select("id")
        .single();

      if (assetErr || !assetRow) {
        throw new Error(`importDeck: failed to insert asset row — ${assetErr?.message}`);
      }

      const ext = mimeToExt(asset.mime_type);
      const storage_path = `${opts.workspace_id}/${deck_id}/${assetRow.id}.${ext}`;

      const { error: uploadErr } = await admin.storage
        .from("decks")
        .upload(storage_path, asset.data, {
          contentType: asset.mime_type,
          upsert: false,
        });

      if (uploadErr) {
        throw new Error(`importDeck: failed to upload asset to storage — ${uploadErr.message}`);
      }

      const { error: updateErr } = await admin
        .from("canvas_deck_asset")
        .update({ storage_path })
        .eq("id", assetRow.id);

      if (updateErr) {
        throw new Error(`importDeck: failed to finalise asset path — ${updateErr.message}`);
      }

      const url = `/api/canvas/asset/${assetRow.id}`;
      placeholderToUrl.set(asset.placeholder_id, url);
      urlByContentHash.set(contentHash, url);
      minted_assets += 1;
    }

    // 2b. Rewrite asset placeholders the parser left in theme_css (CSS
    //     `background-image:url(data:…)` etc. — see parser.extractCssAssets).
    //     The deck row was inserted in step 1 with the placeholder theme_css
    //     because assets can't be minted until the deck_id exists; now that
    //     placeholderToUrl is built we patch the row. Mirrors the asset
    //     storage_path "insert empty → update real" pattern above. Skipped when
    //     the rewrite is a no-op (no CSS data URLs were lifted).
    const themeWithAssets = rewriteAssetPlaceholders(parsed.theme_css, (p) =>
      placeholderToUrl.get(p),
    );
    // meta.chrome_html shares the slides' asset placeholder counter (see
    // parser.extractChromeHtml) so it gets the same post-insert rewrite.
    // `?? ""` guards synthetic ParsedDeck objects from older callers/tests.
    const parsedChrome = parsed.chrome_html ?? "";
    const chromeWithAssets = rewriteAssetPlaceholders(parsedChrome, (p) =>
      placeholderToUrl.get(p),
    );
    const patch: Record<string, unknown> = {};
    if (themeWithAssets !== parsed.theme_css) patch.theme_css = themeWithAssets;
    if (chromeWithAssets !== parsedChrome) {
      patch.meta = {
        lang: parsed.lang,
        ...parsed.meta,
        ...(chromeWithAssets ? { chrome_html: chromeWithAssets } : {}),
      };
    }
    if (Object.keys(patch).length > 0) {
      const { error: themeErr } = await admin
        .from("canvas_deck")
        .update(patch)
        .eq("id", deck_id);
      if (themeErr) {
        throw new Error(
          `importDeck: failed to rewrite theme_css assets — ${themeErr.message}`,
        );
      }
    }

    // 3. Insert slides with placeholders rewritten and editor-hint overlays
    //    stripped. The hint strip drops corner-of-the-slide labels like
    //    "CLIQUE NOS TEXTOS PARA EDITAR" that Claude-generated decks bake in
    //    as scaffolding for click-to-edit; Canvas edits go through MCP per
    //    ADR 0003, so those hints are misleading dead UI. See
    //    `lib/canvas/strip-hints.ts` for the heuristics.
    //
    //    The strip walker is hand-rolled string scanning over arbitrary HTML
    //    and could in principle throw on a pathological input. A bad hint
    //    walker must not kill the whole import — on failure we log and
    //    preserve the pre-strip body.
    const slideRows = parsed.slides.map((slide) => {
      const bodyWithAssets = rewriteAssetPlaceholders(
        slide.html_body,
        (p) => placeholderToUrl.get(p),
      );
      let bodyAfterHints = bodyWithAssets;
      try {
        bodyAfterHints = stripEditorHints(bodyWithAssets);
      } catch (err) {
        console.warn(
          `[importDeck] stripEditorHints threw, preserving original slide HTML — deck_id=${deck_id} position=${slide.position} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return {
        workspace_id: opts.workspace_id,
        deck_id,
        position: slide.position,
        title: slide.title,
        html_body: bodyAfterHints,
        slide_styles: slide.slide_styles,
        created_by: opts.user_id,
      };
    });

    if (slideRows.length > 0) {
      const { error: slideErr } = await admin.from("canvas_deck_slide").insert(slideRows);
      if (slideErr) {
        throw new Error(`importDeck: failed to insert slides — ${slideErr.message}`);
      }
    }

    return {
      deck_id,
      slide_count: parsed.slides.length,
      // Unique assets actually stored, not raw data: URL occurrences.
      asset_count: minted_assets,
    };
  } catch (err) {
    // Best-effort cleanup. The ON DELETE CASCADE on canvas_deck removes slides,
    // assets, versions, locks, etc. Storage objects are orphaned (a later
    // janitor will GC them; tracked in DESIGN.md §11).
    await admin.from("canvas_deck").delete().eq("id", deck_id);
    throw err;
  }
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/avif":
      return "avif";
    case "font/woff":
      return "woff";
    case "font/woff2":
      return "woff2";
    default:
      return "bin";
  }
}
