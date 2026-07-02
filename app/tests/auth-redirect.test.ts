import { describe, expect, it } from "vitest";
import {
  protectedPageNextPath,
  safeNextPath,
} from "../src/lib/auth/redirect";

describe("authentication redirects", () => {
  it("preserves an exact protected deep link and query", () => {
    expect(protectedPageNextPath("/settings/mcp", "?from=deck")).toBe(
      "/settings/mcp?from=deck",
    );
    expect(protectedPageNextPath("/canvases/deck-1", "?slide=slide-2")).toBe(
      "/canvases/deck-1?slide=slide-2",
    );
  });

  it("does not turn public pages or APIs into login redirects", () => {
    expect(protectedPageNextPath("/login")).toBeNull();
    expect(protectedPageNextPath("/p/public-token")).toBeNull();
    expect(protectedPageNextPath("/api/health")).toBeNull();
    expect(protectedPageNextPath("/canvases-elsewhere")).toBeNull();
  });

  it("continues to reject external next targets", () => {
    expect(safeNextPath("//evil.example/path")).toBeNull();
    expect(safeNextPath("https://evil.example/path")).toBeNull();
    expect(safeNextPath("/settings/mcp")).toBe("/settings/mcp");
  });
});

