"use client";

import { RetryingThumbnail } from "./thumbnail-retry";

// The deck-index row preview. Delegates the on-demand thumbnail render + bounded
// retry to the shared RetryingThumbnail (see ./thumbnail-retry); this wrapper only
// supplies the deck-row box styling and handles the no-slide case.
export function DeckThumbnail({ src }: { src: string | null }) {
  // No first slide (empty deck, or a slide not at position 0): reserve the same
  // 16:9 box with a dashed border so the row height matches its neighbours.
  if (!src) {
    return (
      <div
        aria-hidden
        className="aspect-video w-24 shrink-0 rounded-[7px] border border-dashed border-border bg-muted/40 sm:w-32"
      />
    );
  }
  // No placeholder → once retries are exhausted it falls through to the bare muted
  // box (a calm placeholder). The deck still opens; only its preview is missing.
  return (
    <RetryingThumbnail
      src={src}
      containerClassName="aspect-video w-24 shrink-0 rounded-[7px] border border-border bg-muted sm:w-32"
    />
  );
}
