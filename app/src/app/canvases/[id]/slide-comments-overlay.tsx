"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { cn, displayName, relativeDate } from "@/lib/utils";
import {
  createComment,
  deleteComment,
  resolveComment,
  unresolveComment,
} from "./actions";
import { MentionText } from "./mention-text";
import { MentionTextarea } from "@/components/mention-textarea";
import type { MentionMember } from "@/lib/canvas/mention";
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

// Overlay that sits on top of the preview iframe and renders pinned
// comments + the "click anywhere to drop a pin" affordance.
//
// Why an overlay in the *host* page instead of injecting pins into the
// iframe HTML:
//   1. The iframe content is the assembled deck — anything in there ends
//      up in exports and share links. Comments are an editor concern, not
//      a deck concern.
//   2. The host page already has Supabase, auth, and the Next.js client
//      router. Talking to the DB from inside the iframe would mean
//      duplicating that plumbing or proxying via postMessage.
//
// The trade-off: the host doesn't know the active slide's rect natively,
// so we depend on `canvas:slide-bounds` messages from the controller
// injected by `assembleDeckHtml`. When bounds arrive, we cache the rect
// and use it to position pins at (rect.x + ax*rect.w, rect.y + ay*rect.h).

type SlideBounds = {
  position: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  viewport: { w: number; h: number };
};

type PendingPin = { x: number; y: number } | null;

type OverlayProps = {
  deckId: string;
  slideId: string;
  slidePosition: number;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  comments: CommentRow[];                   // already filtered to this slide
  commentMode: boolean;                     // host controls — driven by chrome toggle
  activeThreadId: string | null;            // null = no thread open
  onActiveThreadChange: (id: string | null) => void;
  onExitCommentMode: () => void;            // bound to the toolbar + Esc
  currentUserId: string | null;
  currentUserEmail: string | null;
  currentUserName: string | null;
  // Full workspace members can delete anyone's comment (mirrors the RLS
  // delete policy); guests only their own.
  canModerate: boolean;
  // When false (the default), resolved threads don't render at all — no pin,
  // no popover. The rail's "Show resolved" toggle flips this.
  showResolved: boolean;
  // Workspace member roster for the composer's @mention autocomplete.
  members: MentionMember[];
};

export function SlideCommentsOverlay({
  deckId,
  slideId,
  slidePosition,
  iframeRef,
  comments,
  commentMode,
  activeThreadId,
  onActiveThreadChange,
  onExitCommentMode,
  currentUserId,
  currentUserEmail,
  currentUserName,
  canModerate,
  showResolved,
  members,
}: OverlayProps) {
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<SlideBounds | null>(null);
  const [pending, setPending] = useState<PendingPin>(null);
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();

  // Pinned roots — top-level comments with an anchor on this slide. Resolved
  // threads only render when the rail toggle asks for them; hiding the root
  // here also drops its popover, since activeThread resolves from this list.
  const roots = useMemo(
    () =>
      comments.filter(
        (c) =>
          c.slide_id === slideId &&
          c.parent_id == null &&
          c.anchor_x != null &&
          c.anchor_y != null &&
          (showResolved || !c.resolved),
      ),
    [comments, slideId, showResolved],
  );

  // Replies grouped by parent_id, sorted by created_at ascending.
  const repliesByParent = useMemo(() => {
    const map = new Map<string, CommentRow[]>();
    for (const c of comments) {
      if (!c.parent_id) continue;
      const arr = map.get(c.parent_id);
      if (arr) arr.push(c);
      else map.set(c.parent_id, [c]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return map;
  }, [comments]);

  // ---- iframe → host bounds protocol ----------------------------------
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // Only trust messages from our own preview iframe. The iframe is
      // sandboxed to an opaque origin, so check the source window (event.origin
      // is "null" under sandbox and can't be used); this stops any other frame
      // or extension from spoofing slide-bounds and moving comment pins.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; position?: number } & SlideBounds | null;
      if (!data || data.type !== "canvas:slide-bounds") return;
      // Only accept bounds for our current slide; other broadcasts are
      // transition leftovers from the previous slide.
      if (typeof data.position === "number" && data.position !== slidePosition) return;
      setBounds({
        position: data.position ?? slidePosition,
        rect: data.rect ?? null,
        viewport: data.viewport ?? { w: 0, h: 0 },
      });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [iframeRef, slidePosition]);

  // Ask for bounds on mount + whenever the slide changes. The controller
  // also broadcasts on its own after navigate, but explicit requests cover
  // the case where the overlay mounts after the iframe already loaded.
  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    const ping = () => {
      frame.contentWindow?.postMessage(
        { type: "canvas:request-bounds", position: slidePosition },
        "*",
      );
    };
    ping();
    const id = window.setTimeout(ping, 250);
    return () => window.clearTimeout(id);
  }, [iframeRef, slidePosition]);

  // The iframe sends bounds in *its own viewport* pixels. The overlay's
  // container has the same rendered size as the iframe (sibling absolute
  // div), so iframe-viewport pixels map 1:1 to overlay pixels for our
  // standard preview (no scaling/zoom). If we ever scale the iframe with
  // CSS transforms, multiply by (overlay.width / viewport.w).
  const pinPx = useCallback(
    (ax: number, ay: number) => {
      if (!bounds?.rect) return null;
      return {
        left: bounds.rect.x + ax * bounds.rect.w,
        top: bounds.rect.y + ay * bounds.rect.h,
      };
    },
    [bounds],
  );

  // ---- click-to-pin in comment mode -----------------------------------
  const handleCaptureClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!commentMode || !bounds?.rect || !overlayRef.current) return;
    if (activeThreadId) {
      // First click closes any open thread; user can click again to drop a
      // new pin. Matches Figma's escape-then-act pattern.
      onActiveThreadChange(null);
      return;
    }
    const containerRect = overlayRef.current.getBoundingClientRect();
    const px = e.clientX - containerRect.left;
    const py = e.clientY - containerRect.top;
    const ax = (px - bounds.rect.x) / bounds.rect.w;
    const ay = (py - bounds.rect.y) / bounds.rect.h;
    if (ax < 0 || ax > 1 || ay < 0 || ay > 1) {
      // Clicked outside the slide rect (e.g. on the nav chrome). Ignore.
      return;
    }
    setPending({ x: ax, y: ay });
    setDraft("");
    setError(null);
  };

  const cancelPending = useCallback(() => {
    setPending(null);
    setDraft("");
    setError(null);
  }, []);

  // Escape key — peel one layer at a time: pending pin → active thread →
  // comment mode itself. Matches the chip promise ("Esc to exit").
  useEffect(() => {
    if (!pending && !activeThreadId && !commentMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pending) cancelPending();
      else if (activeThreadId) onActiveThreadChange(null);
      else if (commentMode) onExitCommentMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, activeThreadId, commentMode, cancelPending, onActiveThreadChange, onExitCommentMode]);

  // ---- mutations ------------------------------------------------------
  // Each successful mutation pairs the server action (which revalidates the
  // path) with a client-side router.refresh(). The server-side revalidation
  // alone isn't enough: next.config.ts sets `staleTimes.dynamic: 30`, which
  // makes the client router cache hold the previous RSC payload for ~30s
  // before refetching. router.refresh() invalidates that cache for the
  // current route segment so the new state shows up immediately for the user
  // who made the change. Realtime then propagates it to other users.
  const submitNew = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!pending || !draft.trim()) return;
    setError(null);
    startSubmit(async () => {
      const result = await createComment({
        deckId,
        slideId,
        body: draft.trim(),
        anchorX: pending.x,
        anchorY: pending.y,
        parentId: null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPending(null);
      setDraft("");
      if (result.id) onActiveThreadChange(result.id);
      router.refresh();
      // Stay in comment mode after a drop so reviewers can mark up multiple
      // things in one pass without re-toggling. Users exit via the toolbar
      // button, the chip, or Escape.
    });
  };

  const submitReply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeThreadId || !replyDraft.trim()) return;
    setError(null);
    startSubmit(async () => {
      const result = await createComment({
        deckId,
        slideId,
        body: replyDraft.trim(),
        anchorX: null,
        anchorY: null,
        parentId: activeThreadId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReplyDraft("");
      router.refresh();
    });
  };

  const toggleResolve = (comment: CommentRow) => {
    setError(null);
    startSubmit(async () => {
      const result = comment.resolved
        ? await unresolveComment(comment.id, deckId)
        : await resolveComment(comment.id, deckId);
      if (!result.ok) {
        setError(moderationErrorText(result.error));
        return;
      }
      router.refresh();
    });
  };

  const remove = (comment: CommentRow) => {
    setError(null);
    startSubmit(async () => {
      const result = await deleteComment(comment.id, deckId);
      if (!result.ok) {
        setError(moderationErrorText(result.error));
        // deleteComment returns not_authorized both for permission denials
        // and the already-deleted race (0 rows affected) — refresh so a
        // comment another moderator just removed disappears either way.
        if (result.error === "not_authorized") router.refresh();
        return;
      }
      if (comment.id === activeThreadId) onActiveThreadChange(null);
      router.refresh();
    });
  };

  // ---- render ---------------------------------------------------------
  const activeThread = activeThreadId
    ? roots.find((r) => r.id === activeThreadId) ?? null
    : null;
  const activeReplies = activeThread
    ? repliesByParent.get(activeThread.id) ?? []
    : [];

  // Overlay container is `pointer-events: none` so it doesn't swallow iframe
  // interactions in view mode. Pins re-enable `pointer-events: auto` for
  // themselves. In comment mode the capture layer is `pointer-events: auto`
  // to grab clicks.
  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-10"
      aria-hidden={!commentMode && roots.length === 0}
    >
      {commentMode ? (
        <>
          <div
            onClick={handleCaptureClick}
            className={cn(
              "pointer-events-auto absolute inset-0",
              pending ? "cursor-default" : "cursor-crosshair",
              "bg-[color:var(--accent)]/[0.07] ring-2 ring-inset ring-[color:var(--accent)]/40",
            )}
          />
          {/* Floating hint chip — sits above the canvas so it's visible even
              on dark-themed slides. Pointer-events: none so it never eats a
              click meant for the canvas. */}
          <div className="pointer-events-none absolute left-3 top-3 z-30 flex items-center gap-2 rounded-full bg-foreground px-3 py-1.5 text-[11px] font-medium text-background shadow-lg">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[color:var(--accent)]" />
            {pending
              ? "Type your comment, then press ⌘↵ to send"
              : "Click anywhere on the slide to drop a comment · Esc to exit"}
          </div>
        </>
      ) : null}

      {/* Existing pins */}
      {roots.map((root) => {
        if (root.anchor_x == null || root.anchor_y == null) return null;
        const pos = pinPx(root.anchor_x, root.anchor_y);
        if (!pos) return null;
        const isActive = activeThreadId === root.id;
        const replies = repliesByParent.get(root.id) ?? [];
        const total = replies.length + 1;
        return (
          <button
            key={root.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onActiveThreadChange(isActive ? null : root.id);
            }}
            className={cn(
              "pointer-events-auto absolute flex h-7 min-w-7 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-[3px] px-2 text-[11px] font-semibold shadow-md transition",
              root.resolved
                ? "bg-muted text-muted-foreground opacity-60 hover:opacity-100"
                : "bg-[color:var(--accent)] text-white",
              isActive ? "ring-2 ring-offset-2 ring-[color:var(--accent)] ring-offset-card" : "",
            )}
            style={{ left: pos.left, top: pos.top }}
            title={
              root.resolved
                ? `Resolved · ${total} message${total === 1 ? "" : "s"}`
                : `${total} message${total === 1 ? "" : "s"}`
            }
          >
            {total}
          </button>
        );
      })}

      {/* Pending pin (user clicked, not yet submitted) */}
      {pending && bounds?.rect ? (
        <>
          <div
            className="pointer-events-none absolute"
            style={{
              left: bounds.rect.x + pending.x * bounds.rect.w,
              top: bounds.rect.y + pending.y * bounds.rect.h,
            }}
          >
            <div className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-full rounded-full rounded-bl-[3px] bg-[color:var(--accent)]/80 shadow-md ring-2 ring-card" />
          </div>
          <ThreadPopover
            anchorRef={overlayRef}
            pinTopLeft={{
              left: bounds.rect.x + pending.x * bounds.rect.w,
              top: bounds.rect.y + pending.y * bounds.rect.h,
            }}
          >
            <form onSubmit={submitNew} className="space-y-2 pointer-events-auto">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Avatar email={currentUserEmail} name={currentUserName} />
                <span className="font-medium text-foreground">
                  {displayName({
                    name: currentUserName,
                    email: currentUserEmail ?? "you",
                  })}
                </span>
                <span>·</span>
                <span>new comment</span>
              </div>
              <MentionTextarea
                value={draft}
                onChange={setDraft}
                members={members}
                textareaProps={{
                  autoFocus: true,
                  placeholder: "Add a comment… (@ to mention)",
                  // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 14px on desktop.
                  className:
                    "min-h-[68px] w-full resize-none rounded-[8px] border border-input bg-background px-3 py-2 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm",
                  onKeyDown: (e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      submitNew(e as unknown as FormEvent<HTMLFormElement>);
                    }
                  },
                }}
              />
              {error ? <p className="text-[11px] text-[color:var(--danger)]">{error}</p> : null}
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={cancelPending}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isSubmitting || !draft.trim()}
                >
                  Comment
                </Button>
              </div>
            </form>
          </ThreadPopover>
        </>
      ) : null}

      {/* Existing thread popover */}
      {activeThread && !pending ? (
        (() => {
          if (activeThread.anchor_x == null || activeThread.anchor_y == null) return null;
          const pos = pinPx(activeThread.anchor_x, activeThread.anchor_y);
          if (!pos) return null;
          return (
            <ThreadPopover anchorRef={overlayRef} pinTopLeft={pos}>
              <div className="space-y-3 pointer-events-auto">
                <CommentBubble
                  comment={activeThread}
                  currentUserId={currentUserId}
                  canModerate={canModerate}
                  onDelete={() => remove(activeThread)}
                  isBusy={isSubmitting}
                />
                {activeReplies.map((reply) => (
                  <CommentBubble
                    key={reply.id}
                    comment={reply}
                    currentUserId={currentUserId}
                    canModerate={canModerate}
                    onDelete={() => remove(reply)}
                    isBusy={isSubmitting}
                  />
                ))}

                <form onSubmit={submitReply} className="space-y-2 border-t border-border pt-3">
                  <MentionTextarea
                    value={replyDraft}
                    onChange={setReplyDraft}
                    members={members}
                    textareaProps={{
                      placeholder: "Reply… (@ to mention)",
                      // text-base on mobile so iOS Safari doesn't auto-zoom on focus; 14px on desktop.
                      className:
                        "min-h-[56px] w-full resize-none rounded-[8px] border border-input bg-background px-3 py-2 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm",
                      onKeyDown: (e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          submitReply(e as unknown as FormEvent<HTMLFormElement>);
                        }
                      },
                    }}
                  />
                  {error ? (
                    <p className="text-[11px] text-[color:var(--danger)]">{error}</p>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleResolve(activeThread)}
                      disabled={isSubmitting}
                    >
                      {activeThread.resolved ? "Reopen" : "Resolve"}
                    </Button>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onActiveThreadChange(null)}
                      >
                        Close
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={isSubmitting || !replyDraft.trim()}
                      >
                        Reply
                      </Button>
                    </div>
                  </div>
                </form>
              </div>
            </ThreadPopover>
          );
        })()
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------
// Pieces
// -------------------------------------------------------------------

function CommentBubble({
  comment,
  currentUserId,
  canModerate,
  onDelete,
  isBusy,
}: {
  comment: CommentRow;
  currentUserId: string | null;
  canModerate: boolean;
  onDelete: () => void;
  isBusy: boolean;
}) {
  const isOwn = comment.author_id === currentUserId;
  const isAgent = comment.author_kind === "claude";
  // A link visitor: unverified, client-typed attribution (0064). Labeled as a
  // guest so their name is never mistaken for a workspace member's.
  const isClient = comment.author_kind === "client";
  const handle = isAgent
    ? "Agent"
    : isClient
      ? comment.author_name?.trim() || "Guest"
      : displayName({
          name: comment.author_name,
          email: comment.author_email ?? "unknown",
        });
  return (
    <div className="flex gap-2">
      <Avatar
        email={comment.author_email}
        name={comment.author_name}
        agent={isAgent}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="font-semibold text-foreground">{handle}</span>
          {isClient ? (
            <span className="rounded-full bg-muted px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-muted-foreground">
              guest
            </span>
          ) : null}
          <span
            className="text-muted-foreground"
            suppressHydrationWarning
            title={new Date(comment.created_at).toLocaleString()}
          >
            {relativeDate(comment.created_at)}
          </span>
          {comment.resolved ? (
            <span className="rounded-full bg-[color:var(--accent-wash)] px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-[color:var(--accent)]">
              resolved
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">
          <MentionText text={comment.body} />
        </div>
        {isOwn || canModerate ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={isBusy}
            className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-[color:var(--danger)] disabled:opacity-50"
          >
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Avatar({
  email,
  name,
  agent,
}: {
  email: string | null;
  name?: string | null;
  agent?: boolean;
}) {
  // Prefer the human-readable name's first letter when present — keeps the
  // avatar consistent with the label next to it, especially when two users
  // share a local-part (e.g. `bernardo@a.com` / `bernardo@b.com`).
  const seed = name?.trim() || email || "?";
  const letter = agent
    ? "A"
    : seed.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
        agent
          ? "bg-[color:var(--accent-warm)] text-white"
          : "bg-[color:var(--accent)] text-white",
      )}
    >
      {letter}
    </div>
  );
}

// Anchored popover. Positions itself next to the pin, then nudges into the
// overlay bounds if it would overflow. Pure CSS positioning — no portals
// because we want clipping by the preview pane on purpose (popovers should
// not escape the iframe area).
//
// Layout is computed in a layout effect rather than during render: React 19
// rejects reading `ref.current` during render (cascading-render hazard), so
// the popover paints once at the pin position, then a sync layout pass
// nudges it into the overlay's bounds before the browser shows it.
function ThreadPopover({
  anchorRef,
  pinTopLeft,
  children,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  pinTopLeft: { left: number; top: number };
  children: React.ReactNode;
}) {
  const POPOVER_MIN_HEIGHT = 140;

  // Default width, but never wider than the preview pane minus a small gutter —
  // on a narrow phone the pane can be < 320px, and a fixed 320px popover would
  // spill past the viewport edge. Computed in the layout effect against the
  // live container width and stored so both positioning and the inline width
  // agree.
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({
    left: pinTopLeft.left + 14,
    top: pinTopLeft.top + 6,
    width: 320,
  });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const containerWidth = anchor?.clientWidth ?? 0;
    const containerHeight = anchor?.clientHeight ?? 0;

    // Clamp the width to the pane (leave a 24px gutter) so it can't overflow a
    // narrow mobile preview; fall back to 320 when we have no measurement yet.
    const width = containerWidth
      ? Math.min(320, Math.max(220, containerWidth - 24))
      : 320;

    let left = pinTopLeft.left + 14;
    let top = pinTopLeft.top + 6;

    if (left + width + 16 > containerWidth) {
      // Flip to the left of the pin.
      left = Math.max(8, pinTopLeft.left - width - 14);
    }
    // Final guard: if flipping still overflows (pane narrower than the
    // popover + margins), pin it to the left gutter.
    if (left + width + 8 > containerWidth) {
      left = Math.max(8, containerWidth - width - 8);
    }
    if (top + POPOVER_MIN_HEIGHT + 16 > containerHeight) {
      top = Math.max(8, containerHeight - POPOVER_MIN_HEIGHT - 16);
    }
    setPos({ left, top, width });
  }, [anchorRef, pinTopLeft.left, pinTopLeft.top]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      // max-h-[60dvh]: dynamic viewport height so the popover isn't clipped by
      // mobile Safari's URL bar. max-w cap is a CSS belt-and-suspenders against
      // the JS-computed width while the layout effect settles.
      className="absolute z-20 max-h-[60dvh] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[12px] border border-border bg-card p-4 shadow-xl"
      style={{ left: pos.left, top: pos.top, width: pos.width }}
    >
      {children}
    </div>
  );
}
