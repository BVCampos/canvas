"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Host-rendered deck navigation chrome (Previous / counter / dots / Next).
// Replaces the chrome that assemble.ts used to inject into the iframe and
// rely on the deck's own theme_css to style. Blank-template decks (and any
// deck whose author didn't style .navbar) used to render a stacked, broken
// nav strip; this component is platform-owned and styled with the rest of
// the workspace so the deck CSS can't break it.
//
// Wiring: the parent owns selection state (`selectedId`) and an effect that
// posts `canvas:navigate` to the iframe whenever the selection changes. This
// component just calls `onSelect(slideId)` — no postMessage here. The
// reverse direction (deck's internal keyboard nav, dot click, goTo()) flows
// back to the parent via the `canvas:state` message the iframe broadcasts;
// the parent updates `selectedId` and the chrome re-renders.

type Slide = { id: string; position: number; title: string };

export function DeckChrome({
  slides,
  selectedId,
  onSelect,
}: {
  slides: Slide[];
  selectedId: string | null;
  onSelect: (slideId: string) => void;
}) {
  // Single-slide decks have nowhere to navigate; hiding the chrome matches
  // the conditional in assemble.ts that used to suppress the iframe nav.
  if (slides.length <= 1) return null;

  const ordered = [...slides].sort((a, b) => a.position - b.position);
  const currentIdx = Math.max(
    0,
    ordered.findIndex((s) => s.id === selectedId),
  );
  const total = ordered.length;
  const atFirst = currentIdx <= 0;
  const atLast = currentIdx >= total - 1;

  const go = (idx: number) => {
    const target = ordered[Math.max(0, Math.min(total - 1, idx))];
    if (target && target.id !== selectedId) onSelect(target.id);
  };

  // Dots collapse past a threshold — 12 dots in a row reads as a strip;
  // beyond that we drop them and lean on the counter + arrows. Tightly
  // bounded layout so the chrome stays out of the way of slide content.
  const showDots = total <= 12;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-2 z-[2] flex justify-center"
      aria-label="Deck navigation"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border/80 bg-card/85 px-3 py-1.5 shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={() => go(currentIdx - 1)}
          disabled={atFirst}
          aria-label="Previous slide"
          title="Previous slide (←)"
          className="flex h-8 w-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent sm:h-7 sm:w-7"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>

        {showDots ? (
          <div className="flex items-center gap-1.5">
            {ordered.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(i)}
                aria-label={`Slide ${i + 1}: ${s.title || "untitled"}`}
                aria-current={i === currentIdx ? "true" : undefined}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === currentIdx
                    ? "w-4 bg-foreground"
                    : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70",
                )}
              />
            ))}
          </div>
        ) : null}

        <span
          className="font-machine text-[11px] tabular-nums text-muted-foreground"
          title="Use ← → to navigate"
        >
          <strong className="font-semibold text-foreground">
            {currentIdx + 1}
          </strong>
          <span className="mx-1 opacity-60">/</span>
          {total}
        </span>

        <button
          type="button"
          onClick={() => go(currentIdx + 1)}
          disabled={atLast}
          aria-label="Next slide"
          title="Next slide (→)"
          className="flex h-8 w-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent sm:h-7 sm:w-7"
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
