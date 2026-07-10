// POST /api/mcp/{token} — phase 3.
//
// Single endpoint that speaks MCP JSON-RPC over HTTP. The token in the URL is
// looked up in `canvas_mcp_token` (admin client; bypasses RLS because this
// endpoint is the system-level entrypoint for connected agents). Once we have user_id +
// workspace_id, we hand the request to `dispatchMcp` which routes by method.
// The sibling /api/mcp route forwards bearer-authenticated requests here so
// modern clients can keep the secret out of the URL.
//
// Notifications (no `id`) return HTTP 202 with no body, per JSON-RPC 2.0.
// Requests return application/json with the response envelope.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchMcp } from "@/lib/canvas/mcp/server";
import { logUsage } from "@/lib/usage/log";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { isMcpTokenExpired } from "@/lib/canvas/mcp-token";

export const runtime = "nodejs";
// render_slide / render_deck launch headless Chromium and screenshot every
// slide, which can run well past a default serverless function timeout. Match
// the export routes' budget so a multi-slide render isn't cut off. (Moot on the
// EC2/Cloudflare-Tunnel deploy; matters on any serverless target.)
export const maxDuration = 60;

// Hard caps on the inbound request. The body cap is checked from Content-Length
// before we read/parse, so an oversized payload is rejected cheaply. The batch
// cap bounds how many tool calls one request can fan out into.
const MAX_BODY_BYTES = 2_000_000;
const MAX_BATCH_LENGTH = 20;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || typeof token !== "string") {
    return rpcError(null, -32600, "Missing token");
  }

  const admin = createAdminClient();
  const { data: tokenRow, error: tErr } = await admin
    .from("canvas_mcp_token")
    .select("user_id, workspace_id, revoked_at, last_used_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (tErr) {
    console.error("[mcp:token-lookup]", tErr);
    logUsage({
      event: "mcp.auth_fail",
      surface: "mcp",
      status: "error",
      error: tErr,
      error_code: tErr.code ?? "lookup_failed",
      props: { reason: "lookup_failed" },
    });
    return rpcError(null, -32603, "Token lookup failed");
  }
  const expired = tokenRow ? isMcpTokenExpired(tokenRow.expires_at) : false;
  if (!tokenRow || tokenRow.revoked_at || expired) {
    logUsage({
      event: "mcp.auth_fail",
      surface: "mcp",
      status: "denied",
      props: { reason: !tokenRow ? "invalid_token" : tokenRow.revoked_at ? "revoked" : "expired" },
    });
    return new NextResponse(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: expired ? "Token expired — mint a new one in Settings → Connections" : "Invalid or revoked token" },
    }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  // Defense-in-depth: confirm membership still exists even if a delete-trigger
  // hasn't fired yet (or was bypassed by a service-role write).
  const { data: membership, error: mErr } = await admin
    .from("workspace_memberships")
    .select("user_id")
    .eq("user_id", tokenRow.user_id)
    .eq("workspace_id", tokenRow.workspace_id)
    .maybeSingle();
  if (mErr) {
    console.error("[mcp:membership-check]", mErr);
    logUsage({
      event: "mcp.auth_fail",
      surface: "mcp",
      user_id: tokenRow.user_id,
      workspace_id: tokenRow.workspace_id,
      status: "error",
      error: mErr,
      error_code: mErr.code ?? "membership_lookup_failed",
      props: { reason: "membership_lookup_failed" },
    });
    return rpcError(null, -32603, "Membership lookup failed");
  }
  if (!membership) {
    logUsage({
      event: "mcp.auth_fail",
      surface: "mcp",
      user_id: tokenRow.user_id,
      workspace_id: tokenRow.workspace_id,
      status: "denied",
      props: { reason: "membership_gone" },
    });
    return new NextResponse(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Token revoked or membership ended" },
    }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  // Per-token rate limit (DB-backed; see lib/canvas/rate-limit.ts). A generous
  // ceiling that only trips on runaway/abuse, not normal agent editing.
  if (!(await rateLimitOk(admin, `mcp:${token}`, 240, 60))) {
    logUsage({
      event: "mcp.rate_limited",
      surface: "mcp",
      user_id: tokenRow.user_id,
      workspace_id: tokenRow.workspace_id,
      status: "denied",
      props: { reason: "rate_limited" },
    });
    return rpcErrorWithStatus(null, -32000, "Rate limit exceeded — slow down and retry", 429);
  }

  // Reject oversized payloads before reading the body. We trust Content-Length
  // here as a cheap first gate; the platform also enforces its own body limit.
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return rpcErrorWithStatus(null, -32600, "Request too large", 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  // Activation funnel: only a syntactically valid MCP request counts as the
  // first connection. Parse errors never make the UI claim setup succeeded.
  if (!tokenRow.last_used_at) {
    logUsage({
      event: "activation.first_token_use",
      surface: "mcp",
      user_id: tokenRow.user_id,
      workspace_id: tokenRow.workspace_id,
      status: "ok",
    });
  }

  // Touch connection state after a valid body has been read. MCP clients send
  // their product identity on initialize; persisting it lets Connections say
  // "Codex connected" / "Claude Code connected" without assuming a vendor.
  // Non-initialize tool calls still refresh last_used_at.
  const clientInfo = readMcpClientInfo(body);
  const { error: connectionStateError } = await admin
    .from("canvas_mcp_token")
    .update({
      last_used_at: new Date().toISOString(),
      ...(clientInfo
        ? {
            last_client_name: clientInfo.name,
            last_client_version: clientInfo.version,
          }
        : {}),
    })
    .eq("token", token);
  if (connectionStateError) {
    console.error("[mcp:connection-state]", connectionStateError);
  }

  // Batch support (per JSON-RPC 2.0). Batching is rare but cheap to support.
  if (Array.isArray(body)) {
    if (body.length > MAX_BATCH_LENGTH) {
      return rpcError(null, -32600, "Batch too large");
    }
    const responses: unknown[] = [];
    for (const item of body) {
      const outcome = await dispatchMcp(item, {
        user_id: tokenRow.user_id,
        workspace_id: tokenRow.workspace_id,
      });
      if (outcome.kind === "response") responses.push(outcome.body);
    }
    if (responses.length === 0) {
      return new NextResponse(null, { status: 202 });
    }
    return NextResponse.json(responses);
  }

  const outcome = await dispatchMcp(body, {
    user_id: tokenRow.user_id,
    workspace_id: tokenRow.workspace_id,
  });

  if (outcome.kind === "notification") {
    return new NextResponse(null, { status: 202 });
  }
  return NextResponse.json(outcome.body);
}

export function readMcpClientInfo(
  body: unknown,
): { name: string; version: string | null } | null {
  const candidates = Array.isArray(body) ? body : [body];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const request = candidate as {
      method?: unknown;
      params?: { clientInfo?: { name?: unknown; version?: unknown } };
    };
    if (request.method !== "initialize") continue;
    const name = request.params?.clientInfo?.name;
    const version = request.params?.clientInfo?.version;
    if (typeof name !== "string" || !name.trim()) return null;
    return {
      name: name.trim().slice(0, 120),
      version:
        typeof version === "string" && version.trim()
          ? version.trim().slice(0, 80)
          : null,
    };
  }
  return null;
}

// GET is used by some MCP clients as a capability probe; respond with the
// initialize-style payload so curl works for sanity testing.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: tokenRow } = await admin
    .from("canvas_mcp_token")
    .select("revoked_at, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!tokenRow || tokenRow.revoked_at || isMcpTokenExpired(tokenRow.expires_at)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    name: "canvas",
    version: "0.2.0",
    transport: "http",
    description:
      "POST JSON-RPC 2.0 here. Canvas accepts any MCP-compatible agent.",
    token_prefix: token.slice(0, 8),
  });
}

function rpcError(id: null, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: 200 },
  );
}

// Same JSON-RPC error envelope as rpcError, but with a non-200 HTTP status —
// used for transport-level rejections (e.g. 413 for an oversized body).
function rpcErrorWithStatus(
  id: null,
  code: number,
  message: string,
  status: number,
): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status },
  );
}
