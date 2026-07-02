import { describe, expect, it } from "vitest";
import {
  MCP_TOKEN_TTL_DAYS,
  isMcpTokenExpired,
  mcpTokenExpiresAt,
} from "../src/lib/canvas/mcp-token";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("isMcpTokenExpired", () => {
  it("treats null/undefined (legacy token) as never expiring", () => {
    expect(isMcpTokenExpired(null, NOW)).toBe(false);
    expect(isMcpTokenExpired(undefined, NOW)).toBe(false);
  });

  it("is false for a future expiry, true for a past one", () => {
    expect(isMcpTokenExpired(new Date(NOW + DAY).toISOString(), NOW)).toBe(false);
    expect(isMcpTokenExpired(new Date(NOW - DAY).toISOString(), NOW)).toBe(true);
  });

  it("is false exactly at the boundary (expiry == now is not yet past)", () => {
    expect(isMcpTokenExpired(new Date(NOW).toISOString(), NOW)).toBe(false);
  });

  it("treats an unparseable expiry as not-expired (fail open, don't lock out)", () => {
    expect(isMcpTokenExpired("not-a-date", NOW)).toBe(false);
  });
});

describe("mcpTokenExpiresAt", () => {
  it("returns an ISO timestamp TTL days in the future", () => {
    const iso = mcpTokenExpiresAt(NOW);
    expect(Date.parse(iso)).toBe(NOW + MCP_TOKEN_TTL_DAYS * DAY);
    // round-trips and is not already expired
    expect(isMcpTokenExpired(iso, NOW)).toBe(false);
  });
});
