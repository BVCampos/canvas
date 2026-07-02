import { afterEach, describe, expect, it, vi } from "vitest";
import { appOrigin } from "@/lib/app-url";

// Regression guard for the "Create Deck blocked by CSP" bug: self-hosted Next
// hands route handlers a request.url whose host is localhost:PORT, so absolute
// redirects must be built off NEXT_PUBLIC_APP_URL, never request.url's host.
describe("appOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers NEXT_PUBLIC_APP_URL and strips trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://canvas.21xventures.com/");
    expect(appOrigin({ url: "https://localhost:3001/api/decks/import" })).toBe(
      "https://canvas.21xventures.com",
    );
  });

  it("never leaks request.url's localhost host when the env var is set", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://canvas.21xventures.com");
    expect(appOrigin({ url: "https://localhost:3001/login" })).toBe(
      "https://canvas.21xventures.com",
    );
  });

  it("falls back to the request origin when the env var is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appOrigin({ url: "https://example.test/path?x=1" })).toBe(
      "https://example.test",
    );
  });

  it("falls back to localhost:3001 with neither env var nor request", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appOrigin()).toBe("http://localhost:3001");
  });
});
