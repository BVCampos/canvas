// POST /api/assistant/bridge/cancel-check?token=<mcp token>  (see ADR-0008)
//
// The local canvas-agent bridge is BLOCKED in its `for await (query)` loop while
// a turn runs, so it can't learn about a Stop through the normal poll (which it
// isn't calling mid-turn). Instead it hits this tiny endpoint on a short in-turn
// interval (~1.2s) and aborts the running `claude -p` the moment a stop is
// pending. Read-only: it just reports whether the user has requested a stop for
// THIS prompt (cancel_requested_at set by the Stop server action). The bridge
// then settles the turn via the `canceled` event on /api/assistant/bridge/event.

import { NextResponse, type NextRequest } from "next/server";
import { resolveBridgeToken, extractBridgeToken } from "@/lib/canvas/assistant/bridge-auth";
import { rateLimitOk } from "@/lib/canvas/rate-limit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = extractBridgeToken(request);
  const auth = await resolveBridgeToken(token);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.reason }, { status: auth.status });
  }
  const { admin, userId } = auth;

  // Generous ceiling: each in-flight turn probes at ~1.2s (~50/min) and up to
  // CANVAS_MAX_CONCURRENT_THREADS (default 3) turns can run at once, so ~150/min
  // is normal. 300/60s trips only on a runaway client.
  if (!(await rateLimitOk(admin, `assistant:cancel-check:${token}`, 300, 60))) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const id = body.user_message_id;
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ ok: false, error: "bad_field" }, { status: 400 });
  }

  // Ownership gate (same shape as event/route's ownRow): a token can only ever
  // probe its own prompt. A missing/foreign row reads as "not canceled" rather
  // than leaking existence — the bridge just keeps running.
  const { data, error } = await admin
    .from("canvas_assistant_message")
    .select("user_id, cancel_requested_at, execution_runtime")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[assistant:cancel-check]", error);
    return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
  }
  const canceled =
    !!data &&
    data.user_id === userId &&
    data.execution_runtime !== "openrouter" &&
    data.cancel_requested_at != null;

  return NextResponse.json({ ok: true, canceled });
}
