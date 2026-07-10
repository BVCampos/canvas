// GET /api/public/project/{token}/deck/{deckId}/preview — public, read-only
// render of one deck inside a publicly-shared project.
//
// The project-scoped twin of /api/public/deck/{token}/preview. The unguessable
// project `token` is the single capability for EVERY deck in the project;
// `deckId` is just a selector. Authorization: resolve the project via the
// service-role (admin) client gated solely by an exact match on
// canvas_project.public_share_token, then require the requested deck to belong
// to that project (canvas_deck.project_id = project.id) AND not be marked
// private. A deck whose own visibility is 'private' is excluded from the public
// surface even if its id is known (the membership cascade still shows it to
// invited members; the world-readable link does not). A disabled/rotated link,
// a deckId that isn't in the project, or a private deck yields no row -> 404. We
// never touch anon RLS (see migration 0046).
//
// Read-only by construction: only the deck's own theme + ordered slides are
// assembled. Same sandbox CSP + signed asset URLs as the deck public preview.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleDeckHtml } from "@/lib/canvas/assemble";
import { logViewportShimFallback } from "@/lib/canvas/shim-fallback-log";
import { assetSigQuery } from "@/lib/canvas/asset-sign";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { trustedClientIp } from "@/lib/canvas/client-ip";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; deckId: string }> },
) {
  const { token, deckId } = await params;
  if (!TOKEN_RE.test(token) || !UUID_RE.test(deckId)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();

  // Throttle this unauthenticated, deck-reassembling surface. FAIL-CLOSED, with
  // a per-IP layer keyed off a TRUSTED client IP (CF-Connecting-IP — a spoofed
  // X-Forwarded-For can't mint unlimited buckets) and a per-share-token global
  // cap so the bound holds even without a trusted IP. See client-ip.ts.
  const ip = trustedClientIp(request.headers);
  const perClient = ip
    ? await rateLimitOk(admin, `public-project:ip:${ip}`, 60, 60, "closed")
    : true;
  const perToken = await rateLimitOk(admin, `public-project:tok:${token}`, 600, 60, "closed");
  if (!perClient || !perToken) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  // The token IS the authorization for the whole project.
  const { data: project, error: projErr } = await admin
    .from("canvas_project")
    .select("id")
    .eq("public_share_token", token)
    .maybeSingle();
  if (projErr) {
    console.error("[public-project-preview]", projErr);
    return new NextResponse("Project lookup failed", { status: 500 });
  }
  if (!project) return new NextResponse("Not found", { status: 404 });

  // The deck must belong to this project — that membership, not the deck's own
  // (absent) public token, is what authorizes the render. A deck marked private
  // is excluded from the public surface even if its id is known.
  const { data: deck, error: deckErr } = await admin
    .from("canvas_deck")
    .select("id, title, theme_css, nav_js, meta")
    .eq("id", deckId)
    .eq("project_id", project.id)
    .neq("visibility", "private")
    .maybeSingle();
  if (deckErr) {
    console.error("[public-project-preview:deck]", deckErr);
    return new NextResponse("Deck lookup failed", { status: 500 });
  }
  if (!deck) return new NextResponse("Not found", { status: 404 });

  const { data: slides, error: slidesErr } = await admin
    .from("canvas_deck_slide")
    .select("id, position, title, html_body, slide_styles")
    .eq("deck_id", deck.id)
    .order("position", { ascending: true });

  if (slidesErr) {
    console.error("[public-project-preview:slides]", slidesErr);
    return new NextResponse("Slide lookup failed", { status: 500 });
  }

  // Signal when this deck lands on the squeeze fallback that scrambles fixed-px
  // decks (fires only on that path; see logViewportShimFallback).
  logViewportShimFallback({
    theme_css: deck.theme_css ?? "",
    nav_js: deck.nav_js ?? "",
    surface: "public",
    deck_id: deck.id as string,
  });

  const html = assembleDeckHtml({
    title: deck.title,
    theme_css: deck.theme_css ?? "",
    nav_js: deck.nav_js ?? "",
    meta: (deck.meta ?? {}) as Record<string, unknown>,
    slides: slides ?? [],
    mode: "preview",
    suppressEditHint: true,
  });

  // Sign each asset URL so images load inside the opaque-origin (cookieless)
  // iframe — same mechanism as the deck public preview.
  const now = Date.now();
  const signedHtml = html.replace(
    /\/api\/canvas\/asset\/([0-9a-fA-F-]{36})(?![0-9a-fA-F-])/g,
    (full, assetId: string) => `${full}?${assetSigQuery(assetId, now)}`,
  );

  return new NextResponse(signedHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "SAMEORIGIN",
      // SECURITY: untrusted deck HTML. `sandbox` forces an opaque origin so deck
      // scripts can run but can't reach the app's cookies/origin. Mirrors the
      // deck public preview exactly.
      "Content-Security-Policy": "sandbox allow-scripts allow-popups;",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
