// Unit tests for partitionDecksForView — the pure view-model behind the
// /canvases Active/Archived split (migration 0074). Extracted from the async
// page server component precisely so these subtle bits are covered: the shelf
// ordering, and the DELIBERATE filtered-vs-unfiltered asymmetry of the tab count.

import { describe, expect, it } from "vitest";
import { partitionDecksForView } from "../src/lib/canvas/deck-list-view";

type Deck = { id: string; archived_at: string | null };

const active = (id: string): Deck => ({ id, archived_at: null });
const archived = (id: string, at: string): Deck => ({ id, archived_at: at });

describe("partitionDecksForView", () => {
  it("splits active from archived", () => {
    const items = [active("a"), archived("b", "2026-06-01T00:00:00.000Z"), active("c")];
    const { activeItems, archivedItems } = partitionDecksForView(items, items, false);
    expect(activeItems.map((d) => d.id)).toEqual(["a", "c"]);
    expect(archivedItems.map((d) => d.id)).toEqual(["b"]);
  });

  it("orders the archived shelf most-recently-archived first", () => {
    const items = [
      archived("old", "2026-01-01T00:00:00.000Z"),
      archived("new", "2026-06-01T00:00:00.000Z"),
      archived("mid", "2026-03-01T00:00:00.000Z"),
    ];
    const { archivedItems } = partitionDecksForView(items, items, true);
    expect(archivedItems.map((d) => d.id)).toEqual(["new", "mid", "old"]);
  });

  it("orders by the parsed instant, not lexicographically — mixed valid formats still sort chronologically", () => {
    // Same two instants, different valid renderings (Z vs +00:00 offset). A
    // string localeCompare would mis-order these; a Date-based compare doesn't.
    const items = [
      archived("earlier", "2026-06-01T00:00:00+00:00"),
      archived("later", "2026-06-01T09:00:00.000Z"),
    ];
    const { archivedItems } = partitionDecksForView(items, items, true);
    expect(archivedItems.map((d) => d.id)).toEqual(["later", "earlier"]);
  });

  it("counts archived from the UNFILTERED set so the tab badge doesn't shrink while searching", () => {
    const allItems = [active("a"), archived("b", "2026-06-01T00:00:00.000Z"), archived("c", "2026-06-02T00:00:00.000Z")];
    // A search narrowed the active view to just "a" — but the badge should still
    // report both archived decks, not zero.
    const filtered = [active("a")];
    const { totalArchived, archivedItems } = partitionDecksForView(filtered, allItems, false);
    expect(totalArchived).toBe(2);
    // The list itself follows the filter (nothing archived matched the search).
    expect(archivedItems).toHaveLength(0);
  });

  it("shows the tab once something is archived", () => {
    const items = [active("a"), archived("b", "2026-06-01T00:00:00.000Z")];
    expect(partitionDecksForView(items, items, false).showArchivedTab).toBe(true);
  });

  it("hides the tab when nothing is archived and you're on the active view", () => {
    const items = [active("a"), active("b")];
    expect(partitionDecksForView(items, items, false).showArchivedTab).toBe(false);
  });

  it("keeps the tab visible when you're on the archived view even with nothing archived", () => {
    // Reachable via a hand-typed ?archived=1 or after unarchiving the last deck
    // — the toggle must stay so you can navigate back to Active.
    const items = [active("a")];
    expect(partitionDecksForView(items, items, true).showArchivedTab).toBe(true);
  });
});
