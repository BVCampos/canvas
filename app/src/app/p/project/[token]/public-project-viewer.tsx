"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { Logo } from "@/components/logo";
import { DeckViewer, type DeckViewerSlide } from "@/components/deck-viewer";

// Public project viewer. The token authorizes the whole project, so this is a
// thin index over the shared DeckViewer: list the project's decks, and on click
// open that deck full-bleed via the cookieless project-scoped preview route.
// DeckViewer's `onExit` returns to the index (instead of dead-ending, the way
// the single-deck /p/{token} viewer has no exit). A single-deck project skips
// the index and opens straight into the deck.

export type PublicProjectDeck = {
  id: string;
  title: string;
  slides: DeckViewerSlide[];
};

export function PublicProjectViewer({
  token,
  projectName,
  decks,
}: {
  token: string;
  projectName: string;
  decks: PublicProjectDeck[];
}) {
  // A one-deck project has nothing to index — open it directly.
  const [activeDeckId, setActiveDeckId] = useState<string | null>(
    decks.length === 1 ? decks[0].id : null,
  );

  const activeDeck = activeDeckId
    ? decks.find((d) => d.id === activeDeckId) ?? null
    : null;

  if (activeDeck) {
    return (
      <DeckViewer
        previewSrc={`/api/public/project/${token}/deck/${activeDeck.id}/preview`}
        title={activeDeck.title}
        slides={activeDeck.slides}
        brand
        // Single-deck project: no index to return to.
        onExit={decks.length > 1 ? () => setActiveDeckId(null) : undefined}
        exitTitle="Back to project"
      />
    );
  }

  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <div className="flex flex-col items-center gap-6 text-center">
          <Logo />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Shared project
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              {projectName}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {decks.length} deck{decks.length === 1 ? "" : "s"} · view only
            </p>
          </div>
        </div>

        {decks.length === 0 ? (
          <div className="mt-10 rounded-[12px] border border-border bg-card p-12 text-center">
            <h2 className="text-lg font-semibold tracking-tight">
              No decks yet
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              This project doesn&rsquo;t have any decks to show.
            </p>
          </div>
        ) : (
          <ul className="mt-10 divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-card">
            {decks.map((deck) => (
              <li key={deck.id}>
                <button
                  type="button"
                  onClick={() => setActiveDeckId(deck.id)}
                  className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-[color:var(--accent-wash)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-muted text-muted-foreground">
                    <Play aria-hidden className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {deck.title || "Untitled deck"}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {deck.slides.length} slide
                      {deck.slides.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
