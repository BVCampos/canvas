"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AtSign,
  CheckCircle2,
  Inbox,
  MessageSquareReply,
  XCircle,
} from "lucide-react";
import { relativeDate } from "@/lib/utils";
import { unreadCount, type NotificationKind } from "@/lib/canvas/notifications";
import { markNotificationRead, markAllNotificationsRead } from "./actions";

// Client feed: renders the notification list, marks a row read on click before
// navigating into the deck, and offers "Mark all read". Mirrors the inbox
// proposal-list's visual conventions (rounded card, divide-y rows,
// accent-wash hover) so the two feeds feel like siblings.

export type NotificationFeedRow = {
  id: string;
  kind: NotificationKind;
  actorName: string | null;
  deckId: string | null;
  deckTitle: string | null;
  slideId: string | null;
  slidePosition: number | null;
  slideTitle: string | null;
  commentId: string | null;
  editId: string | null;
  bodyPreview: string | null;
  readAt: string | null;
  createdAt: string;
};

const KIND_VERB: Record<NotificationKind, string> = {
  mention: "mentioned you",
  comment_reply: "replied to your comment",
  proposal_waiting: "sent a proposal for review",
  proposal_applied: "applied your proposal",
  proposal_rejected: "rejected your proposal",
  // Client comments have no actor user — the guest's name rides in the body
  // preview ("Ana: slide 4 chart is wrong"), so the verb reads on its own.
  client_comment: "left feedback on the shared link",
};

// Build the deck link for a row. We deep-link to the slide (deck-workspace
// restores the selected slide from ?slide=) so a click lands on the comment's
// slide; deck-level threads (no slide) just open the deck.
function hrefFor(row: NotificationFeedRow): string | null {
  if (!row.deckId) return null;
  const query = new URLSearchParams();
  if (row.slideId) query.set("slide", row.slideId);
  if (row.editId) {
    query.set("proposal", row.editId);
    if (row.kind !== "proposal_waiting") query.set("full", "1");
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/canvases/${row.deckId}${suffix}`;
}

function iconFor(kind: NotificationKind) {
  switch (kind) {
    case "comment_reply":
    case "client_comment":
      return MessageSquareReply;
    case "proposal_waiting":
      return Inbox;
    case "proposal_applied":
      return CheckCircle2;
    case "proposal_rejected":
      return XCircle;
    default:
      return AtSign;
  }
}

export function NotificationFeed({ rows }: { rows: NotificationFeedRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistic local read-state so a clicked / marked-all row dims immediately
  // without waiting for the server round-trip + refresh. Seeded from the rows;
  // the server is the source of truth on the next render.
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.readAt != null).map((r) => r.id)),
  );

  const isRead = (row: NotificationFeedRow) =>
    row.readAt != null || readIds.has(row.id);
  const unread = unreadCount(
    rows.map((r) => ({ read_at: isRead(r) ? "read" : null })),
  );

  function handleRowClick(row: NotificationFeedRow) {
    if (!isRead(row)) {
      setReadIds((prev) => new Set(prev).add(row.id));
      startTransition(async () => {
        await markNotificationRead(row.id);
      });
    }
    const href = hrefFor(row);
    if (href) router.push(href);
  }

  function handleMarkAll() {
    setReadIds(new Set(rows.map((r) => r.id)));
    startTransition(async () => {
      await markAllNotificationsRead();
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-[12px] border border-dashed border-border bg-card/50 p-8 text-center text-sm text-muted-foreground">
        <p>You&apos;re all caught up.</p>
        <p className="mt-1">
          Mentions, replies, and proposal updates will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground tabular-nums">
          {unread} unread
        </span>
        <button
          type="button"
          onClick={handleMarkAll}
          disabled={unread === 0 || isPending}
          className="text-xs font-medium text-[color:var(--accent)] transition-colors hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
        >
          Mark all read
        </button>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-card">
        {rows.map((row) => {
          const read = isRead(row);
          const Icon = iconFor(row.kind);
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => handleRowClick(row)}
                className="flex w-full items-start gap-3 px-4 py-4 text-left hover:bg-[color:var(--accent-wash)] sm:px-5"
              >
                {/* Unread dot — a steady accent marker on the left rail. Holds
                    its width when read (invisible) so rows don't shift. */}
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    read ? "bg-transparent" : "bg-[color:var(--accent)]"
                  }`}
                  aria-hidden
                />
                <Icon
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
                    <span
                      className={
                        read ? "text-muted-foreground" : "font-semibold text-foreground"
                      }
                    >
                      {row.actorName ?? "Someone"}
                    </span>
                    <span className={read ? "text-muted-foreground" : "text-foreground"}>
                      {KIND_VERB[row.kind]}
                    </span>
                    {row.deckTitle && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="truncate text-muted-foreground">
                          {row.deckTitle}
                          {row.slidePosition != null
                            ? ` · Slide ${row.slidePosition + 1}`
                            : ""}
                        </span>
                      </>
                    )}
                  </div>
                  {row.bodyPreview && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {row.bodyPreview}
                    </p>
                  )}
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    title={new Date(row.createdAt).toLocaleString()}
                  >
                    {relativeDate(row.createdAt)}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
