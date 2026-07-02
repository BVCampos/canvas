// POST /api/public/deck/{token}/track — anonymous view telemetry from the
// public deck viewer (/p/{token}).
//
// The cookieless sibling of the preview route: the unguessable token IS the
// authorization, the deck is resolved via the service-role client by exact
// public_share_token match, and the surface is hardened the same way
// (TOKEN_RE before any DB hit, trusted-IP + per-token rate limits, both
// FAIL-CLOSED). Events land in canvas_usage_event with surface='public'
// through the same server-side logger every other event uses — there is no
// client INSERT path.
//
// The body is a batch ({session, events[]}) flushed by the viewer via
// sendBeacon/fetch, so one open plus N slide dwells cost one request.
// Numbers from this surface are self-reported and forgeable; they are
// directional engagement signals, never authorization or billing inputs.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { trustedClientIp } from "@/lib/canvas/client-ip";
import { logUsageBatch, type UsageEvent } from "@/lib/usage/log";
import {
  parseTrackBatch,
  VIEW_EVENT_OPEN,
  VIEW_EVENT_SLIDE,
} from "@/lib/canvas/engagement";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) {
    return new NextResponse(null, { status: 404 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const batch = parseTrackBatch(body);
  if (!batch) return new NextResponse(null, { status: 400 });

  const admin = createAdminClient();

  // Same fail-closed posture as the preview route, with a third per-session
  // key because events are cheaper to spam than full deck renders.
  const ip = trustedClientIp(request.headers);
  const perClient = ip
    ? await rateLimitOk(admin, `public-track:ip:${ip}`, 120, 60, "closed")
    : true;
  const perToken = await rateLimitOk(admin, `public-track:tok:${token}`, 600, 60, "closed");
  const perSession = await rateLimitOk(
    admin,
    `public-track:ses:${batch.session}`,
    60,
    60,
    "closed",
  );
  if (!perClient || !perToken || !perSession) {
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  const { data: deck, error: deckErr } = await admin
    .from("canvas_deck")
    .select("id, workspace_id")
    .eq("public_share_token", token)
    .maybeSingle();
  if (deckErr) {
    console.error("[public-track]", deckErr);
    return new NextResponse(null, { status: 500 });
  }
  if (!deck) return new NextResponse(null, { status: 404 });

  // Slide events must reference slides of THIS deck — drop anything else so a
  // forged slide_id can't graffiti another deck's report.
  const slideIds = new Set<string>();
  for (const e of batch.events) {
    if (e.type === "slide") slideIds.add(e.slide_id);
  }
  let validSlideIds = new Set<string>();
  if (slideIds.size > 0) {
    const { data: slides } = await admin
      .from("canvas_deck_slide")
      .select("id")
      .eq("deck_id", deck.id)
      .in("id", [...slideIds]);
    validSlideIds = new Set((slides ?? []).map((s) => s.id as string));
  }

  // Shape every accepted event, then flush the whole batch in one insert.
  const usageEvents: UsageEvent[] = [];
  for (const e of batch.events) {
    if (e.type === "open") {
      usageEvents.push({
        event: VIEW_EVENT_OPEN,
        surface: "public",
        workspace_id: deck.workspace_id,
        deck_id: deck.id,
        props: {
          session: batch.session,
          slide_count: e.slide_count,
          referrer_host: e.referrer_host ?? undefined,
        },
      });
      continue;
    }
    if (!validSlideIds.has(e.slide_id)) continue;
    usageEvents.push({
      event: VIEW_EVENT_SLIDE,
      surface: "public",
      workspace_id: deck.workspace_id,
      deck_id: deck.id,
      slide_id: e.slide_id,
      duration_ms: e.ms,
      props: {
        session: batch.session,
        position: e.position,
        reached_end: e.reached_end || undefined,
      },
    });
  }
  logUsageBatch(usageEvents);

  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
