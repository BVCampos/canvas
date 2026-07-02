"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { cn, relativeDate } from "@/lib/utils";
import {
  approveProposal,
  rejectProposal,
  withdrawProposal,
} from "@/app/canvases/proposal-actions";
import { mergeApproveProposal } from "@/app/canvases/merge-actions";
import { REVERTABLE_KINDS } from "@/lib/canvas/proposal-types";
import { ProposalDiff, type EditKind } from "@/components/proposal-diff";
import {
  getProposalSheetData,
  type ProposalSheetData,
} from "@/app/canvases/proposal-queries";
import { loadProposalSheet } from "@/app/canvases/load-proposal-sheet";
import { RetryingThumbnail } from "../thumbnail-retry";
import type { PendingProposalRow } from "./page";

const KIND_LABEL: Record<string, string> = {
  slide_edit: "SLIDE.EDIT",
  slide_html: "SLIDE.HTML",
  slide_styles: "SLIDE.CSS",
  slide_title: "SLIDE.LABEL",
  slide_create: "SLIDE.NEW",
  slide_reorder: "SLIDE.REORDER",
  slide_delete: "SLIDE.DELETE",
  theme_css: "THEME.CSS",
  nav_js: "NAV.JS",
  deck_title: "DECK.TITLE",
};

// REVERTABLE_KINDS (the slide-content kinds whose approval produces a revertable
// version) is the single source in proposal-types.ts — imported above, shared
// with deck-workspace.tsx and assistant-panel.tsx.

type ProposalPermissions = {
  canApprove: boolean;
  canReject: boolean;
  canWithdraw: boolean;
};

type ProposalChipProps = {
  proposals: PendingProposalRow[];
  activeProposalId: string | null;
  onActivate: (id: string | null) => void;
  onOpenFull: (id: string) => void;
  deckId: string;
  variant: "slide" | "deck";
  permissionsById: Record<string, ProposalPermissions>;
  stalenessById?: Record<string, { stale: boolean; message: string }>;
  // The post-decision strip is OWNED BY THE WORKSPACE and passed down: it
  // must outlive this chip. Approving a slide's last pending unmounts the
  // chip on router.refresh (its queue empties / the variant flips), and a
  // chip-local strip died with it — taking the Undo button along. The chip
  // renders the strip in its top slot while mounted; the workspace renders
  // a standalone strip card when no chip is up.
  strip: DecisionStrip | null;
  onDecided: (decision: ProposalDecision) => void;
  onUndo: () => void;
  // Visual compare (the before↔after wipe). `compareAvailable` is true only
  // for kinds the preview can render as an overlay (LENS_KINDS); structural
  // kinds have no wipe, so the button is hidden for them. `compareActive`
  // reflects whether the wipe is currently pulled to "current" (button looks
  // pressed). `onToggleCompare` flips between proposed and current — the
  // discoverable counterpart to the seam drag + Alt-hold, both of which stay.
  compareAvailable: boolean;
  compareActive: boolean;
  onToggleCompare: () => void;
  // Human multi-select approve. `selectedIds` is the set of ticked proposals
  // (owned by the workspace so it survives this chip remounting). `onToggleSelect`
  // flips one id; shiftKey requests a range from the last toggle, resolved by the
  // workspace against the queue order this chip passes back. `onApproveSelected`
  // approves the approvable selection sequentially. `selectedApprovableCount`
  // drives the bulk button's label + visibility (0 ⇒ hidden).
  selectedIds: Set<string>;
  onToggleSelect: (id: string, shiftKey: boolean, order: string[]) => void;
  onApproveSelected: () => void;
  selectedApprovableCount: number;
};

type ActionType = "approve" | "merge_approve" | "reject" | "withdraw";

// What the chip reports upward after a committed decision.
export type ProposalDecision = {
  type: ActionType;
  editId: string;
  // The slide the approve touched — feeds the History deep link when an undo
  // hits the anti-clobber guard.
  slideId: string | null;
  // Approve of a slide-content kind only; reject/withdraw are non-destructive
  // (the proposal stays readable in the inbox + sheet) so they get no Undo.
  canUndo: boolean;
};

export type DecisionStrip = ProposalDecision & {
  undoing: boolean;
  // Set when revertProposal fails (anti-clobber, RPC denial). The full
  // display string — the undo handler builds it per failure code. Replaces
  // the result line with the error + a History link; no auto-dismiss.
  undoError: string | null;
};

export function ProposalChip({
  proposals,
  activeProposalId,
  onActivate,
  onOpenFull,
  deckId,
  variant,
  permissionsById,
  stalenessById,
  strip,
  onDecided,
  onUndo,
  compareAvailable,
  compareActive,
  onToggleCompare,
  selectedIds,
  onToggleSelect,
  onApproveSelected,
  selectedApprovableCount,
}: ProposalChipProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Inline (non-modal) change diff. Holds the id of the proposal whose diff is
  // expanded in place — null when collapsed. Replaces the old D → modal sheet
  // for EVERY kind: the panel renders below the chip, so it never steals the
  // keyboard (A/R/X/J/K keep working) and works for theme/nav/structural kinds
  // the wipe can't show, not just slide_html. The full ProposalSheet stays for
  // the inbox / deep links via onOpenFull's caller.
  const [inlineDiffId, setInlineDiffId] = useState<string | null>(null);
  // Optimistic-hide for just-acted-on proposals. The server action commits
  // immediately, but router.refresh() takes a beat to drop the row from the
  // server-fetched props; this set hides it from the queue in the meantime so
  // the chip can advance without flashing the decided row.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  // Guards against double-fired decisions (a second A press, a double click)
  // while the previous server action is still in flight.
  const actingRef = useRef(false);

  // Reconcile `dismissed` against the live props (render-phase adjust, same
  // pattern as the workspace's lastSlideId): once router.refresh drops a
  // decided row from `proposals`, its id has no optimistic-hide work left to
  // do. Without this the set grows monotonically over a long review session.
  const liveIds = useMemo(
    () => new Set(proposals.map((p) => p.id)),
    [proposals],
  );
  if ([...dismissed].some((id) => !liveIds.has(id))) {
    setDismissed(new Set([...dismissed].filter((id) => liveIds.has(id))));
  }
  // Collapse the inline diff if its proposal has left the queue (decided
  // elsewhere, or dismissed) — render-phase adjust, same idiom as `dismissed`.
  if (inlineDiffId != null && (!liveIds.has(inlineDiffId) || dismissed.has(inlineDiffId))) {
    setInlineDiffId(null);
  }

  const visibleProposals = useMemo(
    () => proposals.filter((p) => !dismissed.has(p.id)),
    [proposals, dismissed],
  );

  // Resolve which proposal is active; fall back to the first in the list when
  // the parent hasn't synced an id yet (initial mount).
  const active =
    visibleProposals.find((p) => p.id === activeProposalId) ??
    visibleProposals[0] ??
    null;

  // This chip "owns" the keyboard only when it actually holds the
  // parent-selected proposal. The slide chip and deck chip render disjoint
  // proposal sets, so exactly one of them is controlled at a time — that's how
  // we keep a single global keydown listener per chip from double-firing.
  const isControlled =
    activeProposalId != null &&
    visibleProposals.some((p) => p.id === activeProposalId);

  // Sync the parent the first time we mount with proposals but no selection.
  useEffect(() => {
    if (activeProposalId === null && visibleProposals.length > 0) {
      onActivate(visibleProposals[0].id);
    }
  }, [activeProposalId, visibleProposals, onActivate]);

  // ---- immediate commit -------------------------------------------------

  // Commit a decision right away: optimistically hide the row, advance to the
  // next (else previous) proposal — same selection logic as the workspace's A
  // handler — then call the server action. Success reports upward (the
  // workspace shows the result strip); failure brings the row back with an
  // inline error so nothing is silently lost.
  const act = useCallback(
    (type: ActionType, target: PendingProposalRow, actionReason?: string) => {
      if (actingRef.current) return;
      actingRef.current = true;
      setError(null);

      const idx = visibleProposals.findIndex((p) => p.id === target.id);
      const advanceId =
        visibleProposals[idx + 1]?.id ?? visibleProposals[idx - 1]?.id ?? null;
      setDismissed((cur) => {
        const out = new Set(cur);
        out.add(target.id);
        return out;
      });
      onActivate(advanceId);

      startTransition(async () => {
        let result: Awaited<ReturnType<typeof rejectProposal>>;
        try {
          if (type === "approve")
            result = await approveProposal(target.id, deckId);
          else if (type === "merge_approve") {
            // Rebase the stale proposal onto current and apply the clean merge.
            // A conflict (overlapping edits) comes back ok:false; its message
            // tells the reviewer to use "Approve anyway" instead.
            const m = await mergeApproveProposal(target.id, deckId);
            result = m.ok ? { ok: true } : { ok: false, error: m.error };
          } else if (type === "reject")
            result = await rejectProposal(
              target.id,
              deckId,
              actionReason || undefined,
            );
          else result = await withdrawProposal(target.id, deckId);
        } catch {
          // The action call itself died — network blip, or a redeploy rotated
          // the server-action id under a long-lived tab. Fall through to the
          // failure path so the row comes back with a visible error.
          result = {
            ok: false,
            error: "could not reach the server — try again",
          };
        }

        // A racing commit (a second tab) may have resolved the edit first.
        // "is not pending" means the decision DID land.
        if (!result.ok && result.error.includes("is not pending")) {
          result = { ok: true };
        }

        actingRef.current = false;

        if (!result.ok) {
          // Surface the failure and bring the row back so it isn't silently
          // lost.
          setError(`${verb(type)} failed: ${result.error}`);
          setDismissed((prev) => {
            if (!prev.has(target.id)) return prev;
            const out = new Set(prev);
            out.delete(target.id);
            return out;
          });
          onActivate(target.id);
          return;
        }

        onDecided({
          type,
          editId: target.id,
          slideId: target.slide_id,
          canUndo: type === "approve" && REVERTABLE_KINDS.has(target.kind),
        });
        // No explicit router.refresh(): the row is already hidden optimistically
        // (setDismissed above), the server action revalidated the deck route,
        // and the realtime canvas_deck_edit self-echo schedules a debounced
        // loader run as the catch-up. The explicit refresh here was the third
        // redundant loader run per decision (speed discovery 2026-07 #5.1); an
        // applied slide's new content lands via the canvas_deck_slide realtime
        // reducer (#12) reloading the preview.
      });
    },
    [visibleProposals, onActivate, deckId, onDecided],
  );

  // ---- user actions ----------------------------------------------------

  const closeRejectComposer = useCallback(() => {
    setRejectOpen(false);
    setReason("");
  }, []);

  function navigateTo(id: string) {
    closeRejectComposer();
    setError(null);
    onActivate(id);
  }

  // Toggle the inline diff for a proposal: open it if closed (or a different
  // one was open), collapse it if it's the one already showing.
  const toggleInlineDiff = useCallback((id: string) => {
    setInlineDiffId((cur) => (cur === id ? null : id));
  }, []);

  const permissions = active ? permissionsById[active.id] : undefined;
  const canApprove = permissions?.canApprove ?? false;
  const canReject = permissions?.canReject ?? false;
  const canWithdraw = permissions?.canWithdraw ?? false;

  function doApprove() {
    if (!active || !canApprove) return;
    closeRejectComposer();
    act("approve", active);
  }
  function doMergeApprove() {
    if (!active || !canApprove) return;
    closeRejectComposer();
    act("merge_approve", active);
  }
  function doReject(withReason: string) {
    if (!active || !canReject) return;
    closeRejectComposer();
    act("reject", active, withReason);
  }
  function doWithdraw() {
    if (!active || !canWithdraw) return;
    closeRejectComposer();
    act("withdraw", active);
  }

  // ---- keyboard (capture phase so we win over the workspace's A/J/K) ----

  useEffect(() => {
    if (!isControlled) return;
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      // Don't steal keys while typing or while a modal/sheet owns the keyboard.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

      const k = e.key.toLowerCase();
      if (k === "a" && canApprove) {
        e.preventDefault();
        e.stopImmediatePropagation();
        doApprove();
      } else if (k === "r" && canReject) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setError(null);
        setRejectOpen(true);
      } else if (k === "x" && canReject) {
        // Quick reject with no reason.
        e.preventDefault();
        e.stopImmediatePropagation();
        doReject("");
      } else if (k === "d" && active) {
        // Toggle the change diff in place — the inline, NON-MODAL panel for
        // every kind (was a keyboard-stealing modal for non-slide_html kinds).
        // Allowed regardless of permission: viewing the diff is never gated.
        // The panel is non-modal so A/R/X/U/J/K keep working.
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleInlineDiff(active.id);
      }
    }
    // Capture phase: fires before the workspace's bubble-phase handler, so
    // stopImmediatePropagation() here prevents the legacy immediate-approve.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // doApprove/doReject read `active` + permissions via closure; re-bind when
    // those change so the handler always acts on the current proposal. U
    // (undo) lives in the workspace now — the strip outlives this chip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isControlled, active?.id, canApprove, canReject, toggleInlineDiff]);

  // Focus the reason box when the composer opens (esp. via the R shortcut).
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (rejectOpen) reasonRef.current?.focus();
  }, [rejectOpen]);

  // ---- render ----------------------------------------------------------

  // Nothing to show *and* no strip up → render nothing (parent decides
  // whether to show an empty state elsewhere).
  if ((visibleProposals.length === 0 || !active) && !strip) return null;

  const containerClass =
    variant === "slide"
      ? // w-[min(340px,calc(100vw-1.5rem))]: keep the desktop 340px width but
        // never exceed the viewport minus a 1.5rem gutter so the floating chip
        // always fits (with breathing room) on a 360px phone. max-w-[92%] still
        // caps it to the preview pane when that's the tighter constraint.
        "absolute top-3 right-3 z-20 w-[min(340px,calc(100vw-1.5rem))] max-w-[92%] overflow-hidden rounded-[14px] border border-border bg-card/95 backdrop-blur-sm shadow-lg pointer-events-auto"
      : "w-full overflow-hidden border-b border-border bg-card/95 backdrop-blur-sm";

  const remaining = visibleProposals.length;
  const activeIndex = active
    ? visibleProposals.findIndex((p) => p.id === active.id)
    : -1;
  const prev = activeIndex > 0 ? visibleProposals[activeIndex - 1] : null;
  const next =
    activeIndex >= 0 && activeIndex < visibleProposals.length - 1
      ? visibleProposals[activeIndex + 1]
      : null;

  const staleness = active ? stalenessById?.[active.id] : undefined;

  // The queue order the reviewer is looking at — the anchor for shift-range
  // selection. Passed up on every toggle so the workspace resolves the range
  // against exactly what this chip shows.
  const orderIds = visibleProposals.map((p) => p.id);
  const activeSelected = active ? selectedIds.has(active.id) : false;

  return (
    <div className={containerClass}>
      {strip && <ResultStripView strip={strip} deckId={deckId} onUndo={onUndo} />}

      {/* Human multi-select bulk bar — shown once at least one ticked proposal
          is approvable by this user. Distinct from the auto Claude batch (that
          lives in the right rail); this acts on exactly what the reviewer
          ticked. */}
      {selectedApprovableCount > 0 ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {selectedApprovableCount} selected
          </span>
          <Button
            size="sm"
            className="ml-auto h-7"
            onClick={onApproveSelected}
            title="Approve every ticked proposal you're allowed to approve"
          >
            Approve {selectedApprovableCount} selected
          </Button>
        </div>
      ) : null}

      {active ? (
        <ActiveProposal
          active={active}
          thumbnailUrl={slideThumbnailUrl(deckId, active)}
          remaining={remaining}
          position={activeIndex + 1}
          variant={variant}
          canApprove={canApprove}
          canReject={canReject}
          canWithdraw={canWithdraw}
          stale={staleness?.stale ?? false}
          staleMessage={staleness?.message ?? ""}
          prev={prev}
          next={next}
          rejectOpen={rejectOpen}
          reason={reason}
          reasonRef={reasonRef}
          error={error}
          compareAvailable={compareAvailable}
          compareActive={compareActive}
          onToggleCompare={onToggleCompare}
          selected={activeSelected}
          onToggleSelect={(shiftKey) =>
            onToggleSelect(active.id, shiftKey, orderIds)
          }
          diffOpen={inlineDiffId === active.id}
          onToggleDiff={() => toggleInlineDiff(active.id)}
          onNavigate={navigateTo}
          onApprove={doApprove}
          onMergeApprove={doMergeApprove}
          onOpenReject={() => {
            setError(null);
            setRejectOpen((v) => !v);
          }}
          onChangeReason={setReason}
          onConfirmReject={() => doReject(reason)}
          onCancelReject={closeRejectComposer}
          onWithdraw={doWithdraw}
        />
      ) : (
        // Queue drained but a result strip is still up — keep the strip
        // visible above this calm "all caught up" note.
        <AllCaughtUp variant={variant} />
      )}

      {/* Inline, non-modal change diff. Lazy-loads the proposal's diff payload
          and renders the SAME ProposalDiff the full sheet uses — for every
          kind, not just slide_html — directly below the chip. It's not a
          dialog, so the chip's A/R/X/J/K shortcuts stay live while it's open.
          The full sheet (comments + edit form) is one tap away via onOpenFull. */}
      {active && inlineDiffId === active.id ? (
        <InlineDiffPanel
          editId={active.id}
          deckId={deckId}
          onOpenFull={() => onOpenFull(active.id)}
          onClose={() => setInlineDiffId(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function ActiveProposal({
  active,
  thumbnailUrl,
  remaining,
  position,
  variant,
  canApprove,
  canReject,
  canWithdraw,
  stale,
  staleMessage,
  prev,
  next,
  rejectOpen,
  reason,
  reasonRef,
  error,
  compareAvailable,
  compareActive,
  onToggleCompare,
  selected,
  onToggleSelect,
  diffOpen,
  onToggleDiff,
  onNavigate,
  onApprove,
  onMergeApprove,
  onOpenReject,
  onChangeReason,
  onConfirmReject,
  onCancelReject,
  onWithdraw,
}: {
  active: PendingProposalRow;
  // Thumbnail URL for the slide this proposal touches (proposed state), or null
  // for kinds that don't map to a single slide image. Computed by the parent so
  // it has the deckId.
  thumbnailUrl: string | null;
  remaining: number;
  position: number;
  variant: "slide" | "deck";
  canApprove: boolean;
  canReject: boolean;
  canWithdraw: boolean;
  stale: boolean;
  staleMessage: string;
  prev: PendingProposalRow | null;
  next: PendingProposalRow | null;
  rejectOpen: boolean;
  reason: string;
  reasonRef: React.RefObject<HTMLTextAreaElement | null>;
  error: string | null;
  compareAvailable: boolean;
  compareActive: boolean;
  onToggleCompare: () => void;
  selected: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  diffOpen: boolean;
  onToggleDiff: () => void;
  onNavigate: (id: string) => void;
  onApprove: () => void;
  onMergeApprove: () => void;
  onOpenReject: () => void;
  onChangeReason: (v: string) => void;
  onConfirmReject: () => void;
  onCancelReject: () => void;
  onWithdraw: () => void;
}) {
  const initial =
    active.proposed_by_kind === "claude"
      ? "C"
      : active.proposer_name?.trim().charAt(0).toUpperCase() || "?";

  const showProgress = remaining > 1;

  return (
    <div className={variant === "slide" ? "p-3" : "px-4 py-2.5"}>
      {/* Progress + position */}
      {showProgress && (
        <div className="mb-2 flex items-center gap-2">
          <div className="flex items-center gap-1" aria-hidden>
            {Array.from({ length: Math.min(remaining, 8) }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  i === position - 1
                    ? "scale-150 bg-[color:var(--accent)]"
                    : "bg-border",
                )}
              />
            ))}
          </div>
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {position} of {remaining}
          </span>
        </div>
      )}

      {/* Proposer / kind / staleness / age */}
      <div className="flex items-center gap-2 text-[11px]">
        {/* Multi-select tick — only offered when the user can approve this
            proposal (you'd only batch-select to approve). Shift-click selects
            the range from the last tick; the workspace resolves it against the
            queue order. */}
        {canApprove ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => {
              /* state owned by the workspace; toggled via onClick for shiftKey */
            }}
            onClick={(e) => onToggleSelect(e.shiftKey)}
            aria-label="Select this proposal for bulk approve"
            title="Select for bulk approve (shift-click to select a range)"
            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[color:var(--accent)]"
          />
        ) : null}
        <div
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white",
            active.proposed_by_kind === "claude"
              ? "bg-[color:var(--accent-warm)]"
              : "bg-[color:var(--accent)]",
          )}
        >
          {initial}
        </div>
        <span className="truncate">
          <span className="font-medium">{active.proposer_name ?? "Unknown"}</span>
          {active.proposed_by_kind === "claude" ? " · Agent" : ""}
        </span>
        <span
          className="rounded-[5px] border border-border bg-muted/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
          title="Change type"
        >
          {KIND_LABEL[active.kind] ?? active.kind}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {stale ? (
            <span
              className="inline-flex items-center rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning-fg"
              title={staleMessage}
            >
              Stale
            </span>
          ) : null}
          <span
            className="text-muted-foreground"
            title={new Date(active.created_at).toLocaleString()}
          >
            {relativeDate(active.created_at)}
          </span>
        </span>
      </div>

      {/* Title */}
      <div className="mt-2 text-[13px] font-semibold tracking-tight">
        {labelFor(active)}
      </div>

      {/* Slide thumbnail — a small rendered preview of the slide as THIS
          proposal would leave it, so the reviewer reads the change visually
          before opening the diff. Only for slide-scoped kinds (theme/nav/
          structural don't map to a single slide image). Lazy + placeholder
          fallback, so a 404 / still-rendering / non-image slide never breaks
          the chip layout. See SlideThumbnail. */}
      {thumbnailUrl ? <SlideThumbnail src={thumbnailUrl} /> : null}

      {/* Rationale */}
      {active.rationale ? (
        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {active.rationale}
        </p>
      ) : (
        <p className="mt-1 text-xs italic text-muted-foreground">
          No rationale provided.
        </p>
      )}

      {/* Stale gate */}
      {stale ? (
        <div
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-[8px] border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-warning-fg"
        >
          <span aria-hidden>⚠</span>
          <span>{staleMessage}</span>
        </div>
      ) : null}

      {/* Reject composer */}
      {rejectOpen && canReject ? (
        <div className="mt-3 space-y-2 rounded-[8px] border border-border bg-background/40 p-3">
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => onChangeReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onConfirmReject();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelReject();
              }
            }}
            placeholder="Optional reason — posted as a comment so the proposer sees the why."
            rows={3}
            // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 14px on desktop.
            className="w-full rounded-[8px] border border-border bg-card p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
          />
          <div className="flex items-center gap-2">
            <Button onClick={onConfirmReject} variant="destructive" size="sm">
              Confirm reject
            </Button>
            <Button onClick={onCancelReject} variant="ghost" size="sm">
              Cancel
            </Button>
            <span className="ml-auto text-[10px] text-muted-foreground">
              <Kbd>Enter</Kbd> reject · <Kbd>Esc</Kbd> cancel
            </span>
          </div>
        </div>
      ) : (
        /* Action bar — flex-wrap so the approve/reject cluster drops to a
            second line on the narrow (≤340px) mobile chip instead of being
            clipped by the chip's overflow-hidden. On desktop it still fits on
            one row, so nothing wraps and the layout is unchanged. */
        <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
          <div className="flex items-center gap-1">
            {prev || next ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  // 32px tap target on a phone (the chip is a primary mobile
                  // proposal-review surface); back to the compact 28px at sm+.
                  className="h-8 w-8 sm:h-7 sm:w-7"
                  onClick={() => prev && onNavigate(prev.id)}
                  disabled={!prev}
                  aria-label="Previous proposal"
                  title="Previous proposal (K)"
                >
                  <span aria-hidden>←</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 sm:h-7 sm:w-7"
                  onClick={() => next && onNavigate(next.id)}
                  disabled={!next}
                  aria-label="Next proposal"
                  title="Next proposal (J)"
                >
                  <span aria-hidden>→</span>
                </Button>
              </>
            ) : null}
          </div>

          {compareAvailable ? (
            // Before / After segmented toggle. Swaps the SINGLE preview source
            // between the proposed version (After, the default) and the current
            // slide (Before) — tap-friendly with no Alt key (phones) and no drag
            // that fights swipe-back. The seam drag + Alt-hold still work; this
            // is the discoverable, touch-first counterpart. "After" = not
            // comparing (reveal 0); "Before" = comparing (reveal 1).
            <div
              role="group"
              aria-label="Compare current with proposed"
              className="inline-flex overflow-hidden rounded-[7px] border border-border"
            >
              <button
                type="button"
                onClick={() => {
                  if (!compareActive) onToggleCompare();
                }}
                aria-pressed={compareActive}
                className={cn(
                  "px-2.5 py-1 text-[11px] font-medium transition-colors",
                  compareActive
                    ? "bg-[color:var(--accent)] text-white"
                    : "bg-card text-muted-foreground hover:bg-muted",
                )}
                title="Show the current slide (before the change)"
              >
                Before
              </button>
              <button
                type="button"
                onClick={() => {
                  if (compareActive) onToggleCompare();
                }}
                aria-pressed={!compareActive}
                className={cn(
                  "border-l border-border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  !compareActive
                    ? "bg-[color:var(--accent)] text-white"
                    : "bg-card text-muted-foreground hover:bg-muted",
                )}
                title="Show the proposed version"
              >
                After
              </button>
            </div>
          ) : null}

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleDiff}
            aria-pressed={diffOpen}
            className={cn(diffOpen && "bg-muted text-foreground")}
            title="Show the change diff in place (D)"
          >
            Diff
          </Button>

          <span className="ml-auto flex items-center gap-1.5">
            {canWithdraw && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onWithdraw}
                title="Cancel this proposal you authored"
              >
                Withdraw
              </Button>
            )}
            {canReject && (
              <Button variant="outline" size="sm" onClick={onOpenReject}>
                Reject
              </Button>
            )}
            {stale && canApprove && (
              <Button
                size="sm"
                onClick={onMergeApprove}
                title="Rebase this proposal onto the newer edits and apply the merge — keeps both sets of changes when they don't overlap"
              >
                Merge &amp; approve
              </Button>
            )}
            {canApprove && (
              <Button
                size="sm"
                variant={stale ? "outline" : "default"}
                onClick={onApprove}
                title={
                  stale
                    ? "Apply this proposal as-is, overwriting the newer edits"
                    : "Apply this proposal — creates a new slide version on top of the current state"
                }
              >
                {stale ? "Approve anyway" : "Approve"}
              </Button>
            )}
          </span>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-[6px] border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger-fg"
        >
          {error}
        </p>
      )}
    </div>
  );
}

// Post-decision receipt. Same visual as the old undo strip (inverted bar,
// colored result dot); the decision is already committed, so there is no
// countdown — Approve of a revertable kind carries Undo (U), which calls
// revertProposal. A failed undo swaps the line for the error + History link.
// Exported: the workspace renders it standalone (floating card) whenever no
// chip is mounted to host it.
export function ResultStripView({
  strip,
  deckId,
  onUndo,
}: {
  strip: DecisionStrip;
  deckId: string;
  onUndo: () => void;
}) {
  if (strip.undoError) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 bg-foreground px-3 py-2 text-[12px] text-background"
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
        />
        <span className="min-w-0 flex-1 truncate" title={strip.undoError}>
          {strip.undoError}
        </span>
        <a
          href={`/canvases/${deckId}/history${strip.slideId ? `?slide=${strip.slideId}` : ""}`}
          className="shrink-0 rounded-[6px] border border-background/30 bg-background/15 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-background/25"
        >
          History →
        </a>
      </div>
    );
  }

  const past =
    strip.type === "approve"
      ? "Approved"
      : strip.type === "reject"
        ? "Rejected"
        : "Withdrawn";
  return (
    <div className="flex items-center gap-2.5 bg-foreground px-3 py-2 text-[12px] text-background">
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          strip.type === "approve"
            ? "bg-success"
            : strip.type === "reject"
              ? "bg-danger"
              : "bg-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{past}</span>
      {strip.canUndo ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={strip.undoing}
          className="shrink-0 rounded-[6px] border border-background/30 bg-background/15 px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-background/25 disabled:opacity-50"
        >
          {strip.undoing ? "Undoing…" : "Undo (U)"}
        </button>
      ) : null}
    </div>
  );
}

function AllCaughtUp({ variant }: { variant: "slide" | "deck" }) {
  return (
    <div
      className={cn(
        "text-center",
        variant === "slide" ? "px-4 py-5" : "px-4 py-3",
      )}
    >
      <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-success/15 text-success">
        <span aria-hidden>✓</span>
      </div>
      <div className="text-[12px] font-semibold">All caught up</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        No pending proposals here.
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-border bg-card px-1 py-0.5 font-mono text-[9.5px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

// Inline, NON-MODAL change diff rendered below the chip. It lazy-loads the
// proposal's diff payload via the same read-only server query the full sheet
// uses (getProposalSheetData) and renders the same ProposalDiff component, for
// EVERY kind — so the keyboard-stealing modal is no longer the only way to see
// the diff of a theme/nav/structural proposal. Scrolls within a bounded height
// so a long diff doesn't push the chip's actions off-screen. The full sheet
// (comments + edit form) is still one tap away via onOpenFull.
function InlineDiffPanel({
  editId,
  deckId,
  onOpenFull,
  onClose,
}: {
  editId: string;
  deckId: string;
  onOpenFull: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<ProposalSheetData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset cached state when the proposal changes — render-phase adjust, the
  // same pattern the full sheet uses, so we never flash the previous diff.
  const [lastEditId, setLastEditId] = useState(editId);
  if (lastEditId !== editId) {
    setLastEditId(editId);
    setData(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // loadProposalSheet turns a REJECTED action (5xx / timeout) into a
      // surfaced error rather than pinning the panel on its skeleton forever.
      const { data, error } = await loadProposalSheet(() =>
        getProposalSheetData(editId, deckId),
      );
      if (cancelled) return;
      if (error) {
        setError(error);
        return;
      }
      setData(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [editId, deckId]);

  const loading = data == null && error == null;

  return (
    <div className="border-t border-border bg-background/40">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Change diff
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenFull}
            className="text-[11px] font-medium text-[color:var(--accent)] hover:underline"
            title="Open the full view (comments, edit)"
          >
            Open full view
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diff"
            className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
            title="Hide the diff (D)"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="max-h-[42vh] overflow-auto px-3 pb-3 text-[12px]">
        {loading ? (
          <div className="py-6 text-center text-[11px] text-muted-foreground">
            Loading diff…
          </div>
        ) : error || !data ? (
          <div
            role="alert"
            className="rounded-[8px] border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger-fg"
          >
            {error ?? "Couldn't load the diff."}
          </div>
        ) : (
          (() => {
            const { edit, deck, slide, oldContent, newContent } = data;
            const kind = edit.kind as EditKind;
            return (
              <ProposalDiff
                kind={kind}
                oldContent={oldContent}
                newContent={newContent}
                deck={
                  kind === "slide_html" ||
                  kind === "slide_edit" ||
                  kind === "slide_create"
                    ? {
                        title: deck.title,
                        theme_css: deck.theme_css,
                        nav_js: deck.nav_js,
                        meta: deck.meta,
                      }
                    : null
                }
                slide={
                  (kind === "slide_html" || kind === "slide_edit") && slide
                    ? {
                        position: slide.position,
                        title: slide.title,
                        slide_styles: slide.slide_styles,
                      }
                    : null
                }
                newSlidePayload={data.newSlidePayload}
                slideEditPayload={data.slideEditPayload}
                slideEditBefore={data.slideEditBefore}
              />
            );
          })()
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The kinds whose thumbnail is a single slide: the proposal changes that
// slide's body/styles/title, so a rendered preview of the slide (in the
// proposed state) is meaningful. theme_css / nav_js / deck_title /
// slide_reorder / slide_delete don't map to one slide image, so we show no
// thumbnail for them (the chip stays text-only, as before).
const SLIDE_THUMBNAIL_KINDS = new Set([
  "slide_html",
  "slide_styles",
  "slide_title",
  "slide_edit",
  "slide_create",
]);

// Build the thumbnail URL for a proposal, or null when it isn't slide-scoped.
// Passing ?proposalId renders the slide AS THIS PENDING PROPOSAL would leave it
// (the route mirrors the inline-preview patching), so the reviewer sees the
// change, not the current slide.
function slideThumbnailUrl(
  deckId: string,
  p: PendingProposalRow,
): string | null {
  if (!p.slide_id || !SLIDE_THUMBNAIL_KINDS.has(p.kind)) return null;
  return `/api/decks/${deckId}/slides/${p.slide_id}/thumbnail?proposalId=${p.id}`;
}

// A small rendered slide preview with a graceful fallback. The shared
// RetryingThumbnail reserves the 16:9 box up front (no layout shift), re-requests
// a render shed under the burst, and settles to a "No preview" placeholder if it
// can't load.
function SlideThumbnail({ src }: { src: string }) {
  return (
    <RetryingThumbnail
      src={src}
      containerClassName="mt-2 aspect-video w-full rounded-[8px] border border-border bg-muted/40"
      placeholder={
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
          No preview
        </div>
      }
    />
  );
}

function labelFor(p: PendingProposalRow): string {
  if (p.slide_position != null) {
    return `Slide ${p.slide_position + 1}${
      p.slide_title ? ` — ${p.slide_title}` : ""
    }`;
  }
  return KIND_LABEL[p.kind] ?? p.kind;
}

function verb(type: ActionType): string {
  switch (type) {
    case "approve":
      return "Approve";
    case "merge_approve":
      return "Merge";
    case "reject":
      return "Reject";
    default:
      return "Withdraw";
  }
}
