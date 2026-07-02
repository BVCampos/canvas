// Shared auth for the in-app assistant bridge endpoints (see ADR-0006).
//
// The local `canvas-agent` bridge authenticates to Canvas with the user's
// existing per-user MCP token — no new secret. This resolves that token to a
// (user_id, workspace_id) exactly the way /api/mcp/[token] does: admin client,
// revoked check, defense-in-depth membership check. Bridge route handlers then
// write assistant rows through the same admin client (RLS bypassed), so a token
// only ever acts within its own user + workspace.

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMcpTokenExpired } from "@/lib/canvas/mcp-token";

export type BridgeAuth =
  | { ok: true; admin: SupabaseClient; userId: string; workspaceId: string }
  | { ok: false; status: number; reason: string };

// Extract the bridge token from a request. Prefer the `Authorization: Bearer`
// header — where a long-lived bearer secret belongs — and fall back to the
// legacy `?token=` query param for ONE release while older bridges roll over.
// Query strings are the worst place for this secret: they land in server access
// logs, any reverse-proxy / Cloudflare log, and Referer headers, and this same
// token grants full deck-write via MCP. New bridges send the header; the query
// fallback keeps an older bridge working against the updated server.
export function extractBridgeToken(request: NextRequest): string | null {
  const authz = request.headers.get("authorization");
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (m) return m[1].trim();
  }
  return request.nextUrl.searchParams.get("token");
}

export async function resolveBridgeToken(
  token: string | null | undefined,
): Promise<BridgeAuth> {
  if (!token || typeof token !== "string") {
    return { ok: false, status: 400, reason: "missing_token" };
  }

  const admin = createAdminClient();

  const { data: tokenRow, error: tErr } = await admin
    .from("canvas_mcp_token")
    .select("user_id, workspace_id, revoked_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (tErr) {
    console.error("[assistant:token-lookup]", tErr);
    return { ok: false, status: 500, reason: "lookup_failed" };
  }
  if (!tokenRow || tokenRow.revoked_at) {
    return { ok: false, status: 401, reason: "invalid_token" };
  }
  if (isMcpTokenExpired(tokenRow.expires_at)) {
    return { ok: false, status: 401, reason: "expired_token" };
  }

  // Defense-in-depth: confirm membership still exists (mirrors the MCP route).
  const { data: membership, error: mErr } = await admin
    .from("workspace_memberships")
    .select("user_id")
    .eq("user_id", tokenRow.user_id)
    .eq("workspace_id", tokenRow.workspace_id)
    .maybeSingle();
  if (mErr) {
    console.error("[assistant:membership-check]", mErr);
    return { ok: false, status: 500, reason: "membership_lookup_failed" };
  }
  if (!membership) {
    return { ok: false, status: 401, reason: "membership_gone" };
  }

  return {
    ok: true,
    admin,
    userId: tokenRow.user_id as string,
    workspaceId: tokenRow.workspace_id as string,
  };
}
