import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { extractBridgeToken } from "../src/lib/canvas/assistant/bridge-auth";

// Build a minimal NextRequest-shaped object: extractBridgeToken only reads
// `headers` and `nextUrl.searchParams`.
function req(opts: { authorization?: string; query?: string }): NextRequest {
  return {
    headers: new Headers(opts.authorization ? { authorization: opts.authorization } : {}),
    nextUrl: { searchParams: new URLSearchParams(opts.query ?? "") },
  } as unknown as NextRequest;
}

describe("extractBridgeToken", () => {
  it("reads a Bearer token from the Authorization header", () => {
    expect(extractBridgeToken(req({ authorization: "Bearer mcp_abc123" }))).toBe("mcp_abc123");
  });

  it("is case-insensitive on the Bearer scheme and trims", () => {
    expect(extractBridgeToken(req({ authorization: "bearer   mcp_xyz  " }))).toBe("mcp_xyz");
  });

  it("prefers the header over a query token (header is the secure path)", () => {
    expect(
      extractBridgeToken(req({ authorization: "Bearer mcp_header", query: "token=mcp_query" })),
    ).toBe("mcp_header");
  });

  it("falls back to the ?token= query param when no header (one-release back-compat)", () => {
    expect(extractBridgeToken(req({ query: "token=mcp_query" }))).toBe("mcp_query");
  });

  it("returns null when neither is present", () => {
    expect(extractBridgeToken(req({}))).toBeNull();
  });

  it("ignores a non-Bearer Authorization header and falls back to query", () => {
    expect(
      extractBridgeToken(req({ authorization: "Basic abc", query: "token=mcp_query" })),
    ).toBe("mcp_query");
  });
});
