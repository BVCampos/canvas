"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSnapshot } from "./actions";

// Modal dialog for the "Save snapshot" flow. Lives in the deck editor
// toolbar — opens centered over the workspace, traps Escape, returns
// focus to the trigger when closed. Submission calls the existing
// `createSnapshot` server action; on success the caller refreshes the
// route so the count updates on /canvases/{id}/history.

export function SnapshotDialog({
  open,
  deckId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  deckId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const labelInputRef = useRef<HTMLInputElement | null>(null);

  // Reset fields synchronously when the dialog transitions from closed
  // to open. Using React's "adjusting state on prop change" pattern
  // (mirrors proposal-sheet.tsx) avoids the cascading-render lint trip
  // we'd get from setStates inside a useEffect body.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setLabel("");
      setDescription("");
      setError(null);
    }
  }

  // Autofocus the required field once the dialog is on screen, and remember
  // the element that opened the dialog so we can hand focus back when it
  // closes. Capturing on open + restoring on cleanup keeps keyboard users on
  // the same element they triggered the dialog from (typically the toolbar's
  // Snapshot button) instead of dumping them on <body>.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    labelInputRef.current?.focus();
    return () => {
      // `previouslyFocused` may have been detached or hidden between open
      // and close (rare — e.g. the trigger rerendered conditionally), so
      // guard with `isConnected` + a `focus` capability check.
      if (
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  // Esc closes the dialog. Mirrors the proposal-sheet behaviour so the
  // editor's keyboard shortcuts feel consistent.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while the dialog is open so the underlying editor
  // doesn't scroll behind the backdrop.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Label is required.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createSnapshot(
        deckId,
        trimmed,
        description.trim() || undefined,
      );
      if (!result.ok) {
        // Map the action's machine-readable errors back to something
        // the user can act on. Anything we don't recognise is shown
        // verbatim — RPC errors usually include enough context.
        if (result.error === "label_required") {
          setError("Label is required.");
        } else {
          setError(result.error || "Could not save snapshot.");
        }
        return;
      }
      onSuccess();
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="snapshot-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Close snapshot dialog"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
      />
      {/* Cap to the dynamic viewport and lay out as a column so the form body
          can scroll internally on a short mobile screen — keeps the header and
          the Save/Cancel buttons reachable. */}
      <div className="relative flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-[12px] border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2
            id="snapshot-dialog-title"
            className="text-base font-semibold text-foreground"
          >
            Save snapshot
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Freezes the deck&apos;s current state — theme, nav, every
            slide&apos;s latest version — under a label you can restore
            from later. Cheap to take; safe before risky edits.
          </p>
        </header>
        {/* flex-1 + overflow-y-auto: the form (fields + actions) scrolls within
            the capped height. pb-safe keeps the buttons clear of the iPhone
            home indicator if the dialog bottoms out on a short screen. */}
        <form
          onSubmit={handleSubmit}
          className="flex-1 space-y-4 overflow-y-auto px-5 py-4 pb-safe sm:pb-4"
        >
          <div className="space-y-1.5">
            <label
              htmlFor="snapshot-label"
              className="text-xs font-medium text-foreground"
            >
              Label <span className="text-muted-foreground">(required)</span>
            </label>
            <Input
              id="snapshot-label"
              ref={labelInputRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="before client review"
              maxLength={120}
              required
              disabled={isPending}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="snapshot-description"
              className="text-xs font-medium text-foreground"
            >
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id="snapshot-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything worth remembering about this state."
              rows={3}
              maxLength={500}
              disabled={isPending}
              // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 14px on desktop.
              className="flex w-full rounded-[8px] border border-border bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50 sm:text-sm"
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-fg"
            >
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isPending || !label.trim()}>
              {isPending ? "Saving…" : "Save snapshot"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
