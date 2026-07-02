// GET /api/public/deck/{token}/preview — public, read-only deck render.
//
// The cookieless twin of /api/decks/{id}/preview. Where that route gates on the
// signed-in user's RLS, this one is reachable by ANYONE — the unguessable
// `token` IS the authorization. It powers the public viewer at /p/{token}
// (the "anyone with the link can view" share, à la Google Slides).
//
// Authorization model: resolve the deck via the service-role (admin) client
// gated SOLELY by an exact match on canvas_deck.public_share_token. A deck whose
// link was never enabled (token NULL) or was disabled/rotated since simply
// produces no row -> 404. We never touch anon RLS, so there are no anon policies
// to get wrong (see migration 0027).
//
// Read-only by construction: only the deck's own theme + ordered slides are
// assembled. This route deliberately does NOT honour ?proposalId / ?versionId
// (those would leak pending proposals or historical versions to the public) and
// never reads comments. The same sandbox CSP + signed asset URLs as the private
// preview keep untrusted deck HTML caged and let images load without a cookie.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleDeckHtml } from "@/lib/canvas/assemble";
import { assetSigQuery } from "@/lib/canvas/asset-sign";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { trustedClientIp } from "@/lib/canvas/client-ip";

// Match the server-minted token shape (randomBytes(24).toString("base64url") =>
// 32 url-safe chars). Validating before the DB hit rejects junk paths cheaply
// and guarantees we never query with an empty/degenerate value.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();

  // Each hit re-assembles the whole deck (no-store), so throttle to stop
  // scraping / amplification loops on this unauthenticated surface. Two layers,
  // both FAIL-CLOSED (a limiter outage returns 429, never unbounded access —
  // this is the only throttle here):
  //   • per-IP, but only off a TRUSTED client IP (CF-Connecting-IP). A spoofed
  //     X-Forwarded-For can no longer mint unlimited buckets.
  //   • per-share-token global cap, so a single link's total fan-out is bounded
  //     even when no trusted IP is available (and a genuinely viral link that
  //     fans out to many real viewers is capped per link, not per request).
  const ip = trustedClientIp(request.headers);
  const perClient = ip
    ? await rateLimitOk(admin, `public-deck:ip:${ip}`, 60, 60, "closed")
    : true;
  const perToken = await rateLimitOk(admin, `public-deck:tok:${token}`, 600, 60, "closed");
  if (!perClient || !perToken) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  const { data: deck, error: deckErr } = await admin
    .from("canvas_deck")
    .select("id, title, theme_css, nav_js, meta")
    .eq("public_share_token", token)
    .maybeSingle();

  if (deckErr) {
    console.error("[public-preview]", deckErr);
    return new NextResponse("Deck lookup failed", { status: 500 });
  }
  if (!deck) return new NextResponse("Not found", { status: 404 });

  const { data: slides, error: slidesErr } = await admin
    .from("canvas_deck_slide")
    .select("id, position, title, html_body, slide_styles")
    .eq("deck_id", deck.id)
    .order("position", { ascending: true });

  if (slidesErr) {
    console.error("[public-preview:slides]", slidesErr);
    return new NextResponse("Slide lookup failed", { status: 500 });
  }

  const html = assembleDeckHtml({
    title: deck.title,
    theme_css: deck.theme_css ?? "",
    nav_js: deck.nav_js ?? "",
    meta: (deck.meta ?? {}) as Record<string, unknown>,
    slides: slides ?? [],
    mode: "preview",
    // The click-to-edit hint is editor-only (edits happen via Claude/MCP); a
    // public viewer can't edit, so surfacing it reads as a broken control.
    suppressEditHint: true,
  });

  // The viewer iframe is sandboxed to an opaque origin (CSP below), so its
  // <img> requests to /api/canvas/asset/{id} carry no cookie. Sign each asset
  // URL so the asset route serves them on the strength of the signature — the
  // same mechanism the private preview uses. A signature authorizes exactly one
  // asset id belonging to this (already-public) deck.
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
      // Only our own /p/{token} page frames this.
      "X-Frame-Options": "SAMEORIGIN",
      // SECURITY: untrusted deck HTML. `sandbox` forces an opaque origin so deck
      // scripts can run but can't reach the app's cookies/origin — even if this
      // URL is opened top-level. No allow-same-origin. Mirrors the private
      // preview route exactly.
      "Content-Security-Policy": "sandbox allow-scripts allow-popups;",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
