// Pure view-model for the /canvases deck index's Active/Archived split.
// Extracted from the (async, untestable) page server component so the subtle
// bits — the archived-shelf ordering and the DELIBERATE filtered-vs-unfiltered
// asymmetry of the tab count — are unit-tested (see deck-list-view.test.ts).
//
// A deck is archived iff archived_at is set (migration 0074). archived_at is an
// ISO-8601 timestamp string as it crosses PostgREST.

export type DeckListViewItem = { archived_at: string | null };

export type DeckListView<T> = {
  /** Active decks (archived_at null) — the default list, project-grouped upstream. */
  activeItems: T[];
  /** Archived decks, newest-archived first — the flat shelf. */
  archivedItems: T[];
  /**
   * Count of archived decks in the UNFILTERED set — drives the tab badge and
   * visibility. Kept unfiltered on purpose so the badge doesn't shrink/flicker
   * as the user types in the search box (the list uses the filtered set).
   */
  totalArchived: number;
  /** Show the Active/Archived toggle only once something's archived (or you're on it). */
  showArchivedTab: boolean;
};

/**
 * Split the workspace's decks into the active list and the archived shelf.
 *
 * @param items    decks after the title/status search filter (drives the lists)
 * @param allItems every deck before filtering (drives the stable tab count)
 * @param viewingArchived whether the archived view is currently selected
 */
export function partitionDecksForView<T extends DeckListViewItem>(
  items: T[],
  allItems: T[],
  viewingArchived: boolean,
): DeckListView<T> {
  const activeItems = items.filter((deck) => deck.archived_at == null);
  const archivedItems = items
    .filter((deck) => deck.archived_at != null)
    // Order by the parsed instant, not a string compare, so the sort holds for
    // any valid timestamp rendering (not just the action's toISOString() form).
    // Non-null is guaranteed by the filter above; `?? 0` keeps TS happy.
    .sort(
      (a, b) =>
        new Date(b.archived_at ?? 0).getTime() - new Date(a.archived_at ?? 0).getTime(),
    );
  const totalArchived = allItems.filter((deck) => deck.archived_at != null).length;
  const showArchivedTab = totalArchived > 0 || viewingArchived;
  return { activeItems, archivedItems, totalArchived, showArchivedTab };
}
