"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RetryingThumbnail } from "@/app/canvases/thumbnail-retry";
import {
  copySlideFromDeck,
  listCopySources,
  type CopySourceDeck,
} from "./actions";

// Cross-deck slide reuse picker (slide library v0): pick a deck you can
// read, pick a slide, and it lands at the end of THIS deck as a direct
// additive insert. Two steps in one dialog — proposal shops rebuild the same
// title/team/pricing slides on every deck; this replaces the manual HTML
// port. Copies keep the source's slide_styles but not its deck theme, so a
// copy across unrelated themes may need a restyle afterwards.

export function CopySlideDialog({
  deckId,
  open,
  onClose,
  onCopied,
}: {
  deckId: string;
  open: boolean;
  onClose: () => void;
  // Select the new slide + toast; the caller refreshes.
  onCopied: (slideId: string) => void;
}) {
  const [decks, setDecks] = useState<CopySourceDeck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDeck, setSourceDeck] = useState<CopySourceDeck | null>(null);
  const [copying, setCopying] = useState<string | null>(null);

  // Reset transient state on the open->closed edge during render (compared
  // against a previous-prop snapshot), the way workspace-switcher does — the
  // react-hooks/set-state-in-effect lint bans doing it inside an effect body.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setSourceDeck(null);
      setCopying(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const res = await listCopySources(deckId);
      if (cancelled) return;
      if (res.ok) setDecks(res.decks);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, deckId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async (slideId: string) => {
    if (copying) return;
    setCopying(slideId);
    setError(null);
    const res = await copySlideFromDeck(slideId, deckId);
    setCopying(null);
    if (res.ok) {
      onCopied(res.slideId);
    } else {
      setError(res.error);
    }
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Copy a slide from another deck"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          {sourceDeck ? (
            <button
              type="button"
              onClick={() => setSourceDeck(null)}
              aria-label="Back to deck list"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {sourceDeck ? sourceDeck.title : "Copy a slide from another deck"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {sourceDeck
                ? "Pick the slide to copy — it lands at the end of this deck. Styles travel; the source deck's theme doesn't."
                : "Reuse a finished slide — team, pricing, case study — instead of rebuilding it."}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="mb-3 text-xs text-[color:var(--danger)]">{error}</p>
          ) : null}

          {decks === null ? (
            <div className="flex justify-center py-10">
              <div
                aria-hidden
                className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground"
              />
            </div>
          ) : sourceDeck === null ? (
            decks.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No other decks with slides in this workspace yet.
              </p>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
                {decks.map((deck) => (
                  <li key={deck.id}>
                    <button
                      type="button"
                      onClick={() => setSourceDeck(deck)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {deck.title}
                        </span>
                        <span className="font-machine text-[11px] tabular-nums text-muted-foreground">
                          {deck.slides.length}{" "}
                          {deck.slides.length === 1 ? "slide" : "slides"}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {sourceDeck.slides.map((slide) => (
                <button
                  key={slide.id}
                  type="button"
                  onClick={() => void handleCopy(slide.id)}
                  disabled={copying !== null}
                  className={cn(
                    "group overflow-hidden rounded-[10px] border border-border text-left transition-all hover:border-[color:var(--accent)]/60 disabled:opacity-60",
                    copying === slide.id && "ring-2 ring-[color:var(--accent)]",
                  )}
                >
                  <RetryingThumbnail
                    src={`/api/decks/${sourceDeck.id}/slides/${slide.id}/thumbnail`}
                    containerClassName="aspect-video w-full bg-muted"
                  />
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <span className="font-machine w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                      {slide.position + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {copying === slide.id
                        ? "Copying…"
                        : slide.title || "Untitled slide"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
