import { describe, expect, it } from "vitest";
import {
  buildBrandBlurb,
  isHexColor,
  normalizeBrandTokens,
} from "@/lib/canvas/brand";

describe("normalizeBrandTokens", () => {
  it("keeps valid colors and fonts, drops malformed entries", () => {
    const tokens = normalizeBrandTokens({
      colors: {
        Accent: "#2563EB",
        ink: "#0e1a2b",
        bad: "blue", // not hex — dropped
        "": "#ffffff", // empty key — dropped
      },
      fonts: { sans: "Geist, Inter, sans-serif", display: "" },
    });
    expect(tokens.colors).toEqual({ accent: "#2563eb", ink: "#0e1a2b" });
    expect(tokens.fonts).toEqual({ sans: "Geist, Inter, sans-serif" });
  });

  it("returns an empty bag for garbage input", () => {
    expect(normalizeBrandTokens(null)).toEqual({});
    expect(normalizeBrandTokens("nope")).toEqual({});
    expect(normalizeBrandTokens({ colors: "x", fonts: 3 })).toEqual({});
  });
});

describe("isHexColor", () => {
  it("accepts 3- and 6-digit hex, rejects the rest", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#2563eb")).toBe(true);
    expect(isHexColor("2563eb")).toBe(false);
    expect(isHexColor("#25 63eb")).toBe(false);
  });
});

describe("buildBrandBlurb", () => {
  it("summarizes colors, first font family, and one-lined voice", () => {
    const blurb = buildBrandBlurb({
      name: "21x",
      tokens: {
        colors: { accent: "#2563eb", ink: "#0e1a2b" },
        fonts: { sans: "Geist, Inter, sans-serif" },
      },
      voice: "First person.\nSpecific numbers.",
    });
    expect(blurb).toContain("21x — ");
    expect(blurb).toContain("accent #2563eb");
    expect(blurb).toContain("fonts: sans Geist");
    expect(blurb).toContain("voice: First person. Specific numbers.");
  });

  it("returns null for an empty or missing brand", () => {
    expect(buildBrandBlurb(null)).toBeNull();
    expect(buildBrandBlurb({ name: null, tokens: {}, voice: null })).toBeNull();
    expect(buildBrandBlurb({ name: "Only name", tokens: {}, voice: "" })).toBeNull();
  });

  it("caps a runaway voice", () => {
    const blurb = buildBrandBlurb({
      name: null,
      tokens: {},
      voice: "x".repeat(1000),
    });
    expect(blurb!.length).toBeLessThan(300);
  });
});
