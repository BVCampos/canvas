import { describe, expect, it } from "vitest";
import { trustedClientIp } from "../src/lib/canvas/client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("trustedClientIp", () => {
  it("prefers CF-Connecting-IP (the unspoofable source on our tunnel)", () => {
    expect(
      trustedClientIp(
        h({
          "cf-connecting-ip": "203.0.113.7",
          "x-real-ip": "10.0.0.1",
          "x-forwarded-for": "1.2.3.4",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP when no CF header", () => {
    expect(trustedClientIp(h({ "x-real-ip": "10.0.0.1" }))).toBe("10.0.0.1");
  });

  it("SECURITY: a forged X-Forwarded-For alone yields null, NOT the attacker value", () => {
    // The whole point: a client-controlled XFF must not become a rate-limit
    // bucket key (it would let an attacker mint unlimited buckets).
    expect(trustedClientIp(h({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" }))).toBeNull();
  });

  it("returns null when no trusted header is present", () => {
    expect(trustedClientIp(h({}))).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(trustedClientIp(h({ "cf-connecting-ip": "  203.0.113.7  " }))).toBe("203.0.113.7");
  });
});
