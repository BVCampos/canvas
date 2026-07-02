"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { RetryingThumbnail } from "@/app/canvases/thumbnail-retry";
import type { ProposalActionResult } from "@/app/canvases/proposal-actions";

// The pick-one surface for an A/B variant set (migration 0066): N sibling
// slide_edit proposals rendered as selectable previews, one primary action.
// Replaces the vertical stack of independent ProposalCards the chatbox would
// otherwise show — a variant set is ONE decision, not N approvals.
//
// The generate-compare-choose loop this exists for: the model spends one
// turn producing alternatives the human evaluates visually, instead of many
// turns converging blind (the 27-versions-one-slide failure mode).

export type VariantOption = {
  id: string;
  label: string | null;
};

export function VariantGroupCard({
  deckId,
  slideId,
  slideLabel,
  variants,
  onPick,
  onDiscardAll,
}: {
  deckId: string;
  slideId: string;
  slideLabel: string | null;
  variants: VariantOption[];
  // Resolve to the action result; the caller owns refresh, the card surfaces
  // a failure in place (pick/discard can hit the self-approval guard, a stale
  // proposal, or a partway-failed discard — all silent without this).
  onPick: (editId: string) => Promise<ProposalActionResult>;
  onDiscardAll: () => Promise<ProposalActionResult>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pick" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (kind: "pick" | "discard") => {
    if (busy) return;
    if (kind === "pick" && !selected) return;
    setBusy(kind);
    setError(null);
    let res: ProposalActionResult;
    try {
      res = kind === "pick" ? await onPick(selected!) : await onDiscardAll();
    } catch {
      res = { ok: false, error: "could not reach the server — try again" };
    } finally {
      setBusy(null);
    }
    if (!res.ok) setError(res.error);
  };

  return (
    <div className="w-full max-w-[85%] space-y-2 rounded-[12px] border border-border bg-card p-2.5">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <span className="text-xs font-medium text-foreground">
          {variants.length} options{slideLabel ? ` · ${slideLabel}` : ""}
        </span>
        <span className="font-machine text-[10px] uppercase tracking-wide text-muted-foreground">
          pick one
        </span>
      </div>

      {/* Selectable previews. One column on the narrow panel — each option is
        * a 16:9 thumbnail with its label; radio semantics via aria-pressed. */}
      <div className={cn("grid gap-2", variants.length > 2 && "sm:grid-cols-2")}>
        {variants.map((variant, i) => {
          const isSelected = selected === variant.id;
          return (
            <button
              key={variant.id}
              type="button"
              onClick={() => setSelected(isSelected ? null : variant.id)}
              aria-pressed={isSelected}
              className={cn(
                "group relative overflow-hidden rounded-[10px] border text-left transition-all",
                isSelected
                  ? "border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]"
                  : "border-border hover:border-muted-foreground/40",
              )}
            >
              <RetryingThumbnail
                src={`/api/decks/${deckId}/slides/${slideId}/thumbnail?proposalId=${variant.id}`}
                containerClassName="aspect-video w-full bg-muted"
              />
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="truncate text-xs text-foreground">
                  {variant.label || `Option ${i + 1}`}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-[color:var(--accent)] bg-[color:var(--accent)] text-white"
                      : "border-border bg-background",
                  )}
                >
                  {isSelected ? <Check className="h-3 w-3" /> : null}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => void act("discard")}
          disabled={busy !== null}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {busy === "discard" ? "Discarding…" : "None of these"}
        </button>
        <button
          type="button"
          onClick={() => void act("pick")}
          disabled={busy !== null || selected === null}
          className="rounded-[8px] bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy === "pick" ? "Applying…" : "Use this one"}
        </button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-[6px] border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 px-2 py-1 text-[10.5px] text-[color:var(--danger)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
