import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimitOk } from "../src/lib/canvas/rate-limit";

// Minimal admin-client stand-in: only `.rpc` is exercised.
function clientReturning(result: { data: unknown; error: unknown }): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(result) } as unknown as SupabaseClient;
}
function clientThrowing(): SupabaseClient {
  return { rpc: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as SupabaseClient;
}

describe("rateLimitOk", () => {
  it("allows when the RPC says allowed (data !== false)", async () => {
    const ok = await rateLimitOk(clientReturning({ data: true, error: null }), "b", 10, 60);
    expect(ok).toBe(true);
  });

  it("denies when the RPC says denied (data === false)", async () => {
    const ok = await rateLimitOk(clientReturning({ data: false, error: null }), "b", 10, 60);
    expect(ok).toBe(false);
  });

  it("fails OPEN by default on RPC error", async () => {
    const ok = await rateLimitOk(clientReturning({ data: null, error: { message: "x" } }), "b", 10, 60);
    expect(ok).toBe(true);
  });

  it("fails CLOSED on RPC error when asked (public surfaces)", async () => {
    const ok = await rateLimitOk(
      clientReturning({ data: null, error: { message: "x" } }),
      "b",
      10,
      60,
      "closed",
    );
    expect(ok).toBe(false);
  });

  it("fails CLOSED on a thrown error too", async () => {
    expect(await rateLimitOk(clientThrowing(), "b", 10, 60, "closed")).toBe(false);
    // …and OPEN by default on throw.
    expect(await rateLimitOk(clientThrowing(), "b", 10, 60)).toBe(true);
  });
});
