import { describe, expect, it } from "vitest";
import {
  compareReviewOrder,
  type ReviewOrderFields,
} from "../src/lib/canvas/proposal-types";

// compareReviewOrder turns the DB's `created_at DESC` firehose into the order a
// reviewer actually wants to walk: structural/deck-level edits first, then the
// slides top-to-bottom, oldest-first within a single slide.

const at = (slide_position: number | null, created_at: string): ReviewOrderFields => ({
  slide_position,
  created_at,
});

function order(rows: ReviewOrderFields[]): string[] {
  // Tag each row so we can assert the resulting sequence regardless of the
  // input order. Position is 0-based; "deck" marks a structural edit.
  return [...rows]
    .sort(compareReviewOrder)
    .map((r) => (r.slide_position === null ? `deck@${r.created_at}` : `s${r.slide_position}`));
}

describe("compareReviewOrder", () => {
  it("orders slide proposals by slide position, not arrival time", () => {
    // Arrived newest-first (slide 9 most recent), should walk 2 → 5 → 9.
    const rows = [at(9, "2026-06-02T12:00:00Z"), at(2, "2026-06-02T10:00:00Z"), at(5, "2026-06-02T11:00:00Z")];
    expect(order(rows)).toEqual(["s2", "s5", "s9"]);
  });

  it("puts structural / deck-level proposals (null position) ahead of every slide", () => {
    const rows = [at(0, "2026-06-02T10:00:00Z"), at(null, "2026-06-02T13:00:00Z"), at(3, "2026-06-02T11:00:00Z")];
    const sorted = [...rows].sort(compareReviewOrder);
    expect(sorted[0].slide_position).toBeNull();
    expect(sorted.map((r) => r.slide_position)).toEqual([null, 0, 3]);
  });

  it("breaks ties on the same slide by created_at ascending (oldest first)", () => {
    const older = at(4, "2026-06-02T09:00:00Z");
    const newer = at(4, "2026-06-02T15:00:00Z");
    const sorted = [newer, older].sort(compareReviewOrder);
    expect(sorted).toEqual([older, newer]);
  });

  it("orders multiple structural proposals oldest-first among themselves", () => {
    const rows = [at(null, "2026-06-02T14:00:00Z"), at(null, "2026-06-02T08:00:00Z")];
    expect(order(rows)).toEqual(["deck@2026-06-02T08:00:00Z", "deck@2026-06-02T14:00:00Z"]);
  });

  it("produces a full walk: structural first, then slides in order, ties oldest-first", () => {
    const rows = [
      at(2, "2026-06-02T10:30:00Z"), // slide 2, second edit
      at(0, "2026-06-02T10:00:00Z"),
      at(null, "2026-06-02T12:00:00Z"), // a theme edit, arrived last
      at(2, "2026-06-02T09:00:00Z"), // slide 2, first edit
      at(1, "2026-06-02T11:00:00Z"),
    ];
    expect(order(rows)).toEqual([
      "deck@2026-06-02T12:00:00Z",
      "s0",
      "s1",
      "s2", // 09:00 (older) before...
      "s2", // 10:30
    ]);
    // Confirm the two slide-2 edits kept oldest-first.
    const sorted = [...rows].sort(compareReviewOrder);
    const slide2 = sorted.filter((r) => r.slide_position === 2).map((r) => r.created_at);
    expect(slide2).toEqual(["2026-06-02T09:00:00Z", "2026-06-02T10:30:00Z"]);
  });

  it("is a stable, total order (no comparator contradictions)", () => {
    const rows = [at(1, "a"), at(null, "b"), at(1, "a"), at(3, "c"), at(null, "a")];
    // Sorting twice yields the same sequence — a sanity check on transitivity.
    const once = [...rows].sort(compareReviewOrder);
    const twice = [...once].sort(compareReviewOrder);
    expect(twice).toEqual(once);
  });
});
