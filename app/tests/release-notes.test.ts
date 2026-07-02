import { describe, expect, it } from "vitest";
import { RELEASES } from "../src/lib/canvas/release-notes";

// The release list is hand-curated, so these checks guard the invariants the
// /releases page renders against: valid dates in strictly descending order,
// and no empty groups or blank copy.

describe("release notes data", () => {
  it("uses valid ISO dates, strictly newest first", () => {
    for (const release of RELEASES) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${release.date}T00:00:00Z`))).toBe(false);
    }
    const dates = RELEASES.map((r) => r.date);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
    // Strictly: one group per day, so dates double as React keys.
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("has a headline and at least one item with complete copy per release", () => {
    for (const release of RELEASES) {
      expect(release.title.length).toBeGreaterThan(0);
      expect(release.items.length).toBeGreaterThan(0);
      for (const item of release.items) {
        expect(item.title.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
        if (item.prs) {
          expect(item.prs.length).toBeGreaterThan(0);
          for (const pr of item.prs) {
            expect(Number.isInteger(pr) && pr > 0).toBe(true);
          }
        }
      }
    }
  });

  it("item titles are unique within a release (they key the rendered list)", () => {
    for (const release of RELEASES) {
      const titles = release.items.map((i) => i.title);
      expect(new Set(titles).size).toBe(titles.length);
    }
  });
});
