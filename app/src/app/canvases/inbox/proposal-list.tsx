"use client";

import { type ReactNode } from "react";
import { relativeDate } from "@/lib/utils";
import type { ProposalBase } from "@/lib/canvas/proposal-types";
import { RetryingThumbnail } from "../thumbnail-retry";

// Client-side wrapper for the inbox proposal list. Each row links into the
// deck editor with `?proposal=<id>` so the editor opens the inline review
// chip on the matching slide. Modifier-clicks (cmd/ctrl/shift) and
// middle-clicks open the deck in a new tab via default browser behavior.

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-warning/15 text-warning-fg border-warning/40",
  applied: "bg-success/15 text-success-fg border-success/40",
  rejected: "bg-danger/15 text-danger-fg border-danger/40",
  superseded: "bg-muted text-muted-foreground border-border",
};

const KIND_LABEL: Record<string, string> = {
  slide_edit: "Slide edit",
  slide_html: "Slide HTML",
  slide_styles: "Slide CSS",
  slide_title: "Slide label",
  slide_create: "New slide",
  slide_reorder: "Reorder slides",
  slide_delete: "Delete slide",
  theme_css: "Theme CSS",
  nav_js: "Nav JS",
  deck_title: "Deck title",
};

export type InboxProposalRow = ProposalBase & {
  deck_id: string;
  deck_title: string;
  // The slide this proposal touches, when any. slide_id drives the thumbnail
  // URL; slide_position/title drive the text label. Null for deck-scoped kinds
  // (theme/nav/deck title), which get no thumbnail.
  slide_id: string | null;
  slide_position: number | null;
  slide_title: string | null;
  status: string;
};

// The kinds whose thumbnail is a single slide (the proposal changes that
// slide's body/styles/title). Deck-scoped kinds get no thumbnail.
const SLIDE_THUMBNAIL_KINDS = new Set([
  "slide_html",
  "slide_styles",
  "slide_title",
  "slide_edit",
  "slide_create",
]);

// Thumbnail URL for a row's slide in the PROPOSED state, or null when the
// proposal isn't slide-scoped. ?proposalId renders the slide as the pending
// proposal would leave it, so the reviewer triages the change, not the current
// slide.
function rowThumbnailUrl(row: InboxProposalRow): string | null {
  if (!row.slide_id || !SLIDE_THUMBNAIL_KINDS.has(row.kind)) return null;
  return `/api/decks/${row.deck_id}/slides/${row.slide_id}/thumbnail?proposalId=${row.id}`;
}

export function InboxProposalList({
  rows,
  emptyLabel,
  emptyState,
  showProposer = true,
  openFullDiff = false,
}: {
  rows: InboxProposalRow[];
  emptyLabel?: string;
  emptyState?: ReactNode;
  showProposer?: boolean;
  // When true (the "To review" section), land directly on the full diff sheet
  // (?full=1) rather than the inline chip — the reviewer's intent from the
  // inbox is to read the change, not to land in the editor and click again.
  openFullDiff?: boolean;
}) {
  if (rows.length === 0) {
    if (emptyState) return <>{emptyState}</>;
    return (
      <div className="rounded-[12px] border border-dashed border-border bg-card/50 p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-card">
      {rows.map((row) => (
        <li key={row.id}>
          <a
            href={`/canvases/${row.deck_id}?proposal=${row.id}${openFullDiff ? "&full=1" : ""}`}
            className="flex items-center justify-between gap-3 px-4 py-4 hover:bg-[color:var(--accent-wash)] sm:gap-4 sm:px-5"
          >
            {/* Slide thumbnail (proposed state) so the reviewer triages the
                change visually without opening it. Fixed small 16:9 box on the
                left; rendered only for slide-scoped kinds, with a placeholder
                fallback so a 404 / still-rendering thumbnail never disturbs the
                row. */}
            <RowThumbnail url={rowThumbnailUrl(row)} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate font-semibold text-foreground">
                  {row.deck_title}
                </span>
                {row.slide_position != null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="truncate text-foreground">
                      Slide {row.slide_position + 1}
                      {row.slide_title ? ` — ${row.slide_title}` : ""}
                    </span>
                  </>
                )}
              </div>
              {/* Let the kind · proposer · date metadata wrap on narrow
                  phones instead of clipping or overflowing the row. */}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>{KIND_LABEL[row.kind] ?? row.kind}</span>
                {showProposer && (
                  <>
                    <span>·</span>
                    <span>
                      {row.proposer_name ?? "Unknown"}
                      {row.proposed_by_kind === "claude" ? " via agent" : ""}
                    </span>
                  </>
                )}
                <span>·</span>
                <span title={new Date(row.created_at).toLocaleString()}>
                  {relativeDate(row.created_at)}
                </span>
              </div>
              {row.rationale && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {row.rationale}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status] ?? STATUS_STYLES.superseded}`}
            >
              {row.status}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// A small rendered slide preview for a row, with a graceful fallback. Renders
// nothing for deck-scoped kinds (url null). Otherwise the shared RetryingThumbnail
// reserves a fixed 16:9 box (stable row height), re-requests a render shed under
// the burst, and settles to a "No preview" placeholder if it can't load. Hidden on
// mobile to keep rows compact.
function RowThumbnail({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <RetryingThumbnail
      src={url}
      containerClassName="hidden aspect-video w-[88px] shrink-0 rounded-[6px] border border-border bg-muted/40 sm:block"
      placeholder={
        <div className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground">
          No preview
        </div>
      }
    />
  );
}
