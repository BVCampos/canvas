"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn, displayName, relativeDate } from "@/lib/utils";
import {
  createComment,
  deleteComment,
  resolveComment,
  unresolveComment,
} from "./actions";
import { MentionText } from "./mention-text";
import type { CommentRow } from "./page";

// The moderation actions return machine codes ("not_authorized"); render
// user language instead. Raw/unknown errors are already logged server-side.
function moderationErrorText(code: string): string {
  if (code === "not_authorized")
    return "Couldn't update that comment — it may have been deleted already, or you don't have permission.";
  if (code === "not_authenticated")
    return "Your session expired — sign in again.";
  return "Something went wrong — please try again.";
}

// Rail "Notes" section: surfaces UNPINNED comment threads on the current slide
// — i.e. roots with a null anchor. These are typically the comments Claude
// opens via the MCP `add_comment` tool (it posts without pin coordinates), or
// any slide-scoped note that isn't a pin. The pinned-comments rail + the
// SlideCommentsOverlay both filter to `anchor != null`, so before this these
// threads were fetched by the page yet rendered nowhere — invisible and
// unanswerable. Here the human can read, reply, and resolve them, closing the
// Claude↔human loop the backend already supported.
//
// Serves both scopes: a slide-scoped instance (slideId set) and a deck-wide
// "Deck notes" instance (slideId null). createComment now accepts a null
// slideId, so replies attach to the right scope either way.
export function UnpinnedNotes({
  deckId,
  slideId,
  comments,
  currentUserId,
  canModerate,
  showResolved,
  embedded = false,
  title = "Notes",
  hint = "Unpinned threads on this slide — for example an agent's review notes.",
}: {
  deckId: string;
  // The slide a reply should attach to, or null for deck-level threads.
  slideId: string | null;
  // Comments for this scope (slide-scoped, or deck-level when slideId is null)
  // — roots + replies; the component filters roots to the unpinned ones.
  comments: CommentRow[];
  currentUserId: string | null;
  // Full workspace members can delete anyone's comment (mirrors the RLS
  // delete policy); guests only their own.
  canModerate: boolean;
  // When false (the default), resolved threads don't render at all. The
  // rail's "Show resolved" toggle flips this for every comment surface.
  showResolved: boolean;
  // Embedded mode: the deck editor's merged Comments section renders the
  // group sub-label itself, so suppress this component's own section chrome
  // (border, padding, title/hint block) and emit just the thread list.
  embedded?: boolean;
  title?: string;
  hint?: string;
}) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();

  const roots = comments.filter(
    (c) =>
      c.parent_id == null &&
      c.anchor_x == null &&
      c.anchor_y == null &&
      (showResolved || !c.resolved),
  );
  if (roots.length === 0) return null;

  const repliesByRoot = new Map<string, CommentRow[]>();
  for (const c of comments) {
    if (!c.parent_id) continue;
    const arr = repliesByRoot.get(c.parent_id);
    if (arr) arr.push(c);
    else repliesByRoot.set(c.parent_id, [c]);
  }

  const openThread = (rootId: string, isExpanded: boolean) => {
    setExpandedId(isExpanded ? null : rootId);
    setReplyDraft("");
    setError(null);
  };

  const submitReply = (e: FormEvent<HTMLFormElement>, rootId: string) => {
    e.preventDefault();
    if (!replyDraft.trim()) return;
    setError(null);
    startSubmit(async () => {
      const result = await createComment({
        deckId,
        slideId,
        body: replyDraft.trim(),
        anchorX: null,
        anchorY: null,
        parentId: rootId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReplyDraft("");
      router.refresh();
    });
  };

  const toggleResolve = (c: CommentRow) => {
    setError(null);
    startSubmit(async () => {
      const result = c.resolved
        ? await unresolveComment(c.id, deckId)
        : await resolveComment(c.id, deckId);
      if (!result.ok) setError(moderationErrorText(result.error));
      else router.refresh();
    });
  };

  const removeComment = (c: CommentRow) => {
    setError(null);
    startSubmit(async () => {
      const result = await deleteComment(c.id, deckId);
      if (!result.ok) {
        setError(moderationErrorText(result.error));
        // deleteComment returns not_authorized both for permission denials
        // and the already-deleted race (0 rows affected) — refresh so a
        // comment another moderator just removed disappears from the list.
        if (result.error === "not_authorized") router.refresh();
      } else {
        router.refresh();
      }
    });
  };

  const canDelete = (c: CommentRow) =>
    canModerate || c.author_id === currentUserId;

  const authorLabel = (c: CommentRow) =>
    c.author_kind === "claude"
      ? "Agent"
      : c.author_kind === "client"
        ? c.author_name?.trim() || "Guest"
        : displayName({ name: c.author_name, email: c.author_email ?? "?" });

  // A link visitor (0064): tag their name so it's never mistaken for a
  // workspace member's. Same chip as slide-comments-overlay.
  const guestChip = (c: CommentRow) =>
    c.author_kind === "client" ? (
      <span className="rounded-full bg-muted px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-muted-foreground">
        guest
      </span>
    ) : null;

  const list = (
    <ul className={cn("space-y-1", !embedded && "mt-2")}>
      {roots.map((root) => {
        const replies = repliesByRoot.get(root.id) ?? [];
        const isExpanded = expandedId === root.id;
        const isClaude = root.author_kind === "claude";
        return (
          <li
            key={root.id}
            className="overflow-hidden rounded-[8px] border border-border bg-paper"
          >
            <button
              type="button"
              onClick={() => openThread(root.id, isExpanded)}
              className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted"
            >
              <span
                className={cn(
                  "mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white",
                  isClaude
                    ? "bg-[color:var(--accent-warm)]"
                    : "bg-[color:var(--accent)]",
                )}
              >
                {replies.length + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="truncate font-medium text-foreground">
                    {authorLabel(root)}
                  </span>
                  {guestChip(root)}
                  <span>·</span>
                  <span
                    suppressHydrationWarning
                    title={new Date(root.created_at).toLocaleString()}
                  >
                    {relativeDate(root.created_at)}
                  </span>
                  {root.resolved ? (
                    <span className="rounded-full bg-muted px-1 text-[9px] uppercase tracking-wide">
                      resolved
                    </span>
                  ) : null}
                </div>
                <p
                  className={cn(
                    "mt-0.5 whitespace-pre-wrap text-xs text-foreground",
                    !isExpanded && "line-clamp-2",
                  )}
                >
                  <MentionText text={root.body} />
                </p>
              </div>
            </button>

            {isExpanded ? (
              <div className="space-y-2 border-t border-border px-2.5 py-2">
                {replies.map((r) => (
                  <div key={r.id} className="text-xs">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {authorLabel(r)}
                      </span>
                      {guestChip(r)}
                      <span>·</span>
                      <span
                        suppressHydrationWarning
                        title={new Date(r.created_at).toLocaleString()}
                      >
                        {relativeDate(r.created_at)}
                      </span>
                      {canDelete(r) ? (
                        <button
                          type="button"
                          onClick={() => removeComment(r)}
                          disabled={isSubmitting}
                          className="ml-auto text-[9px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-danger-fg disabled:opacity-50"
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                      <MentionText text={r.body} />
                    </p>
                  </div>
                ))}

                <form
                  onSubmit={(e) => submitReply(e, root.id)}
                  className="space-y-1.5"
                >
                  <textarea
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value)}
                    placeholder="Reply…"
                    rows={2}
                    disabled={isSubmitting}
                    // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 12px on desktop to keep the rail compact.
                    className="block w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:text-xs"
                  />
                  {error ? (
                    <p className="text-[11px] text-danger-fg">{error}</p>
                  ) : null}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleResolve(root)}
                        disabled={isSubmitting}
                        className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        {root.resolved ? "Reopen" : "Resolve"}
                      </button>
                      {canDelete(root) ? (
                        <button
                          type="button"
                          onClick={() => removeComment(root)}
                          disabled={isSubmitting}
                          // Deleting the root removes the whole thread —
                          // replies cascade (0001 ON DELETE CASCADE).
                          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-danger-fg disabled:opacity-50"
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={isSubmitting || !replyDraft.trim()}
                    >
                      {isSubmitting ? "Posting…" : "Reply"}
                    </Button>
                  </div>
                </form>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  if (embedded) return list;

  return (
    <div className="border-b border-border px-5 py-4">
      <div className="eyebrow text-muted-foreground">
        {title}
        <span className="ml-2 text-muted-foreground">{roots.length}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      {list}
    </div>
  );
}
