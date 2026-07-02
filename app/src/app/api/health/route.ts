// GET /api/health — liveness probe.
//
// Public, unauthenticated, dependency-free: it proves the Next server process is
// up and serving, nothing more (it deliberately does NOT touch Supabase, so a
// DB blip doesn't take the box's health signal down with it). The Route53 health
// check on the public hostname hits this through Cloudflare → tunnel → Next, so
// a dead tunnel or wedged service trips the CloudWatch alarm. See app/infra.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { ok: true, service: "canvas" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
