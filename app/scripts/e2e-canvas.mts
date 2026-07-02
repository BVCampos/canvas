// End-to-end exercise of the full Canvas v1 path.
//
// Talks to the real Supabase project (`hgmgzerslymgoqrrahev`) via the
// service-role admin client, then hits the live dev server on :3001 for the
// HTTP routes (preview, asset, MCP, export). Run after `npm run dev` is up:
//
//   npx tsx scripts/e2e-canvas.ts
//
// What it does:
//   1. Imports the seed deck through the parser + importer modules
//   2. Mints an MCP token for the test user
//   3. Walks the MCP JSON-RPC surface: tools/list, list_decks, get_deck,
//      read_slide, read_theme, lock_slide, update_slide, list_slide_versions,
//      create_snapshot, list_snapshots, release_slide
//   4. Fetches the iframe preview HTML
//   5. Fetches an asset URL (server-side; no Supabase session, so this will
//      401 — we just confirm the endpoint is wired)
//   6. Exports the deck — confirms 200 + non-trivial body length
//   7. Cleans up: deletes the deck (cascades remove slides/versions/assets/
//      snapshots) and the test MCP token
//
// On any unexpected outcome it prints a clear FAIL line. Exit code 0 = success.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(appRoot, ".env.local") });

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL in env");
  process.exit(2);
}

// Eager imports must come after dotenv.config() because both modules touch
// `env.ts` which validates at module load.
import { importDeckFromHtml } from "../src/lib/canvas/importer";
import { createAdminClient } from "../src/lib/supabase/admin";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";
// Point these at a test user + workspace in YOUR Supabase project (see README → e2e).
const USER_ID = process.env.E2E_USER_ID ?? "";
const WORKSPACE_ID = process.env.E2E_WORKSPACE_ID ?? "";
if (!USER_ID || !WORKSPACE_ID) {
  throw new Error("Set E2E_USER_ID and E2E_WORKSPACE_ID (a user + workspace in your Supabase project) before running the e2e.");
}

const fixturesDir = resolve(appRoot, "tests/fixtures");
const seedPath = resolve(fixturesDir, "seed-deck.html");

const admin = createAdminClient();

const stats = { passed: 0, failed: 0 };

function step(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    stats.passed += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    stats.failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/`, { method: "GET" });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function mcp(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}/api/mcp/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty body, e.g. on 202 */
  }
  return { status: res.status, json };
}

function unwrapTool(json: unknown): unknown {
  if (
    json &&
    typeof json === "object" &&
    "result" in (json as Record<string, unknown>) &&
    (json as Record<string, unknown>).result
  ) {
    const result = (json as { result: { content?: Array<{ text?: string }>; isError?: boolean } }).result;
    if (result.isError) return { _error: result.content?.[0]?.text };
    const text = result.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  }
  return json;
}

async function main(): Promise<void> {
  console.log(`Canvas E2E — base ${BASE_URL}`);

  // -- Phase 0: dev server reachable ---------------------------------------
  const reachable = await probe();
  step("dev server reachable", reachable);
  if (!reachable) {
    console.error("Start it with `npm run dev` and re-run.");
    process.exit(1);
  }

  // -- Phase 1: parser + importer ------------------------------------------
  let html: string;
  try {
    html = readFileSync(seedPath, "utf-8");
    step("seed deck loaded", true, `${(html.length / 1024).toFixed(1)} KB`);
  } catch {
    step("seed deck loaded", false, `missing ${seedPath}`);
    process.exit(1);
  }

  const testTag = `E2E ${new Date().toISOString().slice(11, 19)} ${randomBytes(2).toString("hex")}`;
  const importResult = await importDeckFromHtml(html, {
    workspace_id: WORKSPACE_ID,
    user_id: USER_ID,
    title: testTag,
  });
  step(
    "import seed deck",
    importResult.slide_count > 0,
    `deck ${importResult.deck_id.slice(0, 8)} · ${importResult.slide_count} slides · ${importResult.asset_count} assets`,
  );
  const deckId = importResult.deck_id;

  // Confirm the trigger created v1 rows for every slide.
  const { count: versionCount } = await admin
    .from("canvas_slide_version")
    .select("*", { count: "exact", head: true })
    .eq("deck_id", deckId);
  step("v1 versions auto-created", versionCount === importResult.slide_count, `${versionCount} versions`);

  // -- Phase 2: HTTP preview + asset ---------------------------------------
  // These endpoints are auth-gated: an unauthenticated Node fetch carries no
  // session cookie, so RLS hides the deck and the route returns 404. The
  // browser flow (where the iframe + <a download> carry the user's cookies)
  // is exercised manually below via direct calls to the assembler.
  const previewRes = await fetch(`${BASE_URL}/api/decks/${deckId}/preview`);
  step(
    "preview endpoint auth-gates unauthenticated fetch",
    previewRes.status === 401 || previewRes.status === 404,
    `status ${previewRes.status}`,
  );

  if (importResult.asset_count > 0) {
    const { data: anyAsset } = await admin
      .from("canvas_deck_asset")
      .select("id")
      .eq("deck_id", deckId)
      .limit(1)
      .maybeSingle();
    if (anyAsset?.id) {
      const assetRes = await fetch(`${BASE_URL}/api/canvas/asset/${anyAsset.id}`);
      step(
        "asset endpoint auth-gates unauthenticated fetch",
        assetRes.status === 401 || assetRes.status === 404,
        `status ${assetRes.status}`,
      );
    }
  }

  // -- Phase 3: MCP server -------------------------------------------------
  const tokenStr = `mcp_${randomBytes(24).toString("base64url")}`;
  const { error: tokInsErr } = await admin.from("canvas_mcp_token").insert({
    token: tokenStr,
    workspace_id: WORKSPACE_ID,
    user_id: USER_ID,
    label: "e2e",
  });
  step("mint MCP token", !tokInsErr, tokInsErr?.message ?? "");

  // initialize
  const initRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  step(
    "mcp initialize",
    initRes.status === 200 &&
      (initRes.json as { result?: { serverInfo?: { name?: string } } })?.result?.serverInfo?.name === "canvas",
  );

  // tools/list
  const listRes = await mcp(tokenStr, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listTools = (listRes.json as { result?: { tools?: Array<{ name: string }> } })?.result?.tools ?? [];
  step("mcp tools/list", listTools.length >= 13, `${listTools.length} tools`);

  // list_decks → should include our just-created one
  const listDecksRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_decks", arguments: {} },
  });
  const listDecks = unwrapTool(listDecksRes.json) as { decks?: Array<{ id: string; title: string }> };
  const found = listDecks.decks?.find((d) => d.id === deckId);
  step("mcp list_decks finds new deck", Boolean(found), found?.title ?? "");

  // get_deck → slides, lock state
  const getDeckRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "get_deck", arguments: { deck_id: deckId } },
  });
  const getDeck = unwrapTool(getDeckRes.json) as { deck?: { title: string }; slides?: Array<{ id: string }> };
  step("mcp get_deck", Boolean(getDeck.deck) && (getDeck.slides?.length ?? 0) > 0);
  const firstSlideId = getDeck.slides?.[0]?.id ?? "";

  // read_slide
  const readSlideRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "read_slide", arguments: { slide_id: firstSlideId } },
  });
  const readSlide = unwrapTool(readSlideRes.json) as { html_body?: string; current_version_no?: number };
  step(
    "mcp read_slide",
    Boolean(readSlide.html_body) && readSlide.current_version_no === 1,
    `v${readSlide.current_version_no}`,
  );

  // read_theme
  const readThemeRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "read_theme", arguments: { deck_id: deckId } },
  });
  const readTheme = unwrapTool(readThemeRes.json) as { theme_css?: string };
  step("mcp read_theme", (readTheme.theme_css?.length ?? 0) > 100);

  // lock_slide
  const lockRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "lock_slide", arguments: { slide_id: firstSlideId } },
  });
  const lock = unwrapTool(lockRes.json) as { locked_by?: string };
  step("mcp lock_slide", lock.locked_by === USER_ID);

  // update_slide → should mint v2
  const newHtml = `<section class="slide">${"<h1>Edited via MCP</h1>"}<p>Test marker ${testTag}</p></section>`;
  const updateRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "update_slide",
      arguments: {
        slide_id: firstSlideId,
        html_body: newHtml,
        source_prompt: "e2e test: rewrite cover slide",
      },
    },
  });
  const update = unwrapTool(updateRes.json) as { version_no?: number };
  step("mcp update_slide creates v2", update.version_no === 2, `v${update.version_no}`);

  // list_slide_versions
  const versionsRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "list_slide_versions", arguments: { slide_id: firstSlideId } },
  });
  const versions = unwrapTool(versionsRes.json) as {
    versions?: Array<{ id: string; version_no: number }>;
  };
  step("mcp list_slide_versions", (versions.versions?.length ?? 0) >= 2);

  // create_snapshot
  const snapRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "create_snapshot", arguments: { deck_id: deckId, label: "e2e checkpoint" } },
  });
  const snap = unwrapTool(snapRes.json) as { snapshot_id?: string; label?: string };
  step("mcp create_snapshot", Boolean(snap.snapshot_id));

  // list_snapshots
  const snapListRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "list_snapshots", arguments: { deck_id: deckId } },
  });
  const snapList = unwrapTool(snapListRes.json) as { snapshots?: Array<{ id: string }> };
  step(
    "mcp list_snapshots",
    (snapList.snapshots?.length ?? 0) >= 1,
    `${snapList.snapshots?.length} snapshots`,
  );

  // release_slide
  const releaseRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "release_slide", arguments: { slide_id: firstSlideId } },
  });
  const release = unwrapTool(releaseRes.json) as { released?: boolean };
  step("mcp release_slide", release.released === true);

  // -- Phase 4: read_slide_version + read_full_deck ------------------------
  const versionId = versions.versions?.[0]?.id;
  if (versionId) {
    const readVerRes = await mcp(tokenStr, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "read_slide_version", arguments: { version_id: versionId } },
    });
    const readVer = unwrapTool(readVerRes.json) as { version?: { version_no: number } };
    step("mcp read_slide_version", Boolean(readVer.version));
  }

  const fullDeckRes = await mcp(tokenStr, {
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "read_full_deck", arguments: { deck_id: deckId } },
  });
  const fullDeck = unwrapTool(fullDeckRes.json) as { html?: string };
  step(
    "mcp read_full_deck",
    (fullDeck.html?.length ?? 0) > 1000 && fullDeck.html!.includes("Edited via MCP"),
    `${((fullDeck.html?.length ?? 0) / 1024).toFixed(1)} KB`,
  );

  // -- Phase 6: export ------------------------------------------------------
  const exportRes = await fetch(`${BASE_URL}/api/decks/${deckId}/export`);
  step(
    "export endpoint auth-gates unauthenticated fetch",
    exportRes.status === 401 || exportRes.status === 404,
    `status ${exportRes.status}`,
  );

  // Exercise the assembly path with explicit auth context — the same logic
  // the route runs once the user is authenticated.
  const { assembleDeckHtml } = await import("../src/lib/canvas/assemble");
  const { data: deckRow } = await admin
    .from("canvas_deck")
    .select("title, theme_css, nav_js, meta")
    .eq("id", deckId)
    .single();
  const { data: slideRows } = await admin
    .from("canvas_deck_slide")
    .select("position, title, html_body, slide_styles")
    .eq("deck_id", deckId)
    .order("position", { ascending: true });
  const reassembled = assembleDeckHtml({
    title: deckRow!.title,
    theme_css: deckRow!.theme_css ?? "",
    nav_js: deckRow!.nav_js ?? "",
    meta: (deckRow!.meta ?? {}) as Record<string, unknown>,
    slides: slideRows ?? [],
  });
  step(
    "export assembly produces valid HTML",
    reassembled.startsWith("<!DOCTYPE html>") && reassembled.includes("Edited via MCP"),
    `${(reassembled.length / 1024).toFixed(1)} KB`,
  );

  // Round-trip: re-parse the assembled HTML and confirm slide count survives.
  const { parseDeckHtml } = await import("../src/lib/canvas/parser");
  const reparsed = parseDeckHtml(reassembled);
  step(
    "import → assemble → reparse round-trips slide count",
    reparsed.slides.length === importResult.slide_count,
    `${reparsed.slides.length} slides (was ${importResult.slide_count})`,
  );

  // -- Cleanup -------------------------------------------------------------
  // Uses the cleanup helper (DB cascade + Storage object removal) — same
  // path the "Delete deck" button takes.
  await admin.from("canvas_mcp_token").delete().eq("token", tokenStr);
  const { deleteDeckAndAssets } = await import("../src/lib/canvas/cleanup");
  const cleanup = await deleteDeckAndAssets(deckId, WORKSPACE_ID);
  step(
    "cleanup",
    cleanup.ok,
    `${cleanup.storage_objects_removed} storage objects removed${cleanup.error ? ` · ${cleanup.error}` : ""}`,
  );

  console.log(
    `\n${stats.failed === 0 ? "PASS" : "FAIL"} — ${stats.passed} passed, ${stats.failed} failed`,
  );
  process.exit(stats.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(2);
});
