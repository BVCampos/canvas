"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

// Subscribes to Supabase Realtime for the four tables that drive the deck's
// live state. Two delivery strategies, picked per table by COST:
//
//   - SURGICAL local patch (hot, small-payload events): canvas_comment and
//     canvas_deck_slide_lock changes are handed to the caller's typed callbacks
//     so deck-workspace can fold the realtime row straight into the local
//     comment / lock overlay state. No loader re-run, so a half-typed comment
//     or an open menu isn't disturbed when a teammate drops a comment or claims
//     a slide. The callback returns `true` when it patched locally and `false`
//     when the payload didn't carry enough (RLS-scoped) data to patch — e.g. a
//     comment from someone outside the cached member roster, whose display name
//     the loader resolves via a users join the realtime row doesn't include. A
//     `false` (or a throw) falls back to the debounced refresh, so behaviour
//     never regresses: the comment / lock still appears, just via a refresh.
//
//   - router.refresh() (debounced) for STRUCTURAL changes: canvas_deck_slide
//     (slide version bumps, reorder, title) and canvas_deck_edit (proposal
//     lifecycle). These re-shape the slides/proposals join the page.tsx server
//     component assembles — versions joined with locks, pending proposals,
//     comment author emails — and re-deriving that in the client is a lot of
//     duplicated logic for the same end result. router.refresh() re-runs the
//     existing server query and only the diffed RSC payload comes back, so the
//     page re-renders with fresh data without a full navigation.
//
// Filtering strategy:
//   - canvas_comment is filtered by deck_id at the realtime layer.
//   - canvas_deck_slide is filtered by deck_id (covers reorder, title edits,
//     current_version_id bumps when an edit is applied or a slide is restored).
//   - canvas_deck_edit is filtered by deck_id (proposal approve/reject/withdraw).
//   - canvas_deck_slide_lock has no deck_id column; the tightest correct filter
//     is workspace_id. We over-fire slightly on lock changes for other decks in
//     the same workspace — the local-patch callback ignores a lock whose
//     slide_id isn't in this deck, and the refresh fallback is cheap anyway.
//     Both stay inside RLS, which already restricts visibility to members.
//
// Debounce:
//   ~400ms after the last event that falls back to refresh. A burst of inserts
//   (e.g. importing 30 slides) collapses into one refresh. Locally-patched
//   events don't touch the debounce — they apply immediately.
//
// Cleanup:
//   Channels are torn down on unmount or when deckId/workspaceId change.

// Row shapes the realtime payload carries for the two surgically-patched
// tables. These mirror the table columns (NOT the page.tsx join) — the loader
// enriches author/holder identity from a users join the WAL row doesn't carry,
// which is exactly why a patch can come back "couldn't resolve, please refresh".
export type CommentRealtimeRow = {
  id: string;
  deck_id: string;
  slide_id: string | null;
  parent_id: string | null;
  body: string;
  author_kind: "user" | "claude" | "client";
  author_id: string | null;
  // Stored attribution for author_kind='client' rows (0064) — carried in the
  // WAL row itself, unlike member identity which needs the users join.
  author_name: string | null;
  author_email: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
};

export type LockRealtimeRow = {
  slide_id: string;
  workspace_id: string;
  locked_by: string;
  locked_by_kind: "user" | "agent";
  acquired_at: string;
  expires_at: string;
};

// The canvas_deck_slide columns the WAL row carries on an UPDATE. current_version_no
// (a version-table join) and pending_proposals (an edits join) are NOT here, so the
// slide reducer patches what the row has and defers the rest to a refresh.
export type SlideRealtimeRow = {
  id: string;
  deck_id: string;
  position: number;
  title: string | null;
  html_body: string;
  slide_styles: string | null;
  owner_id: string | null;
  current_version_id: string | null;
};

// Status payload Supabase emits on `channel.subscribe`. We re-export so the
// caller can switch on it without importing from the supabase-js internals.
export type DeckRealtimeStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

export type UseDeckRealtimeOptions = {
  // Called whenever the realtime subscription transitions state. The parent
  // uses this to surface a non-blocking "live updates paused" banner on
  // CHANNEL_ERROR / TIMED_OUT, and clear it on SUBSCRIBED.
  onStatusChange?: (status: DeckRealtimeStatus) => void;
  // Surgical patch for a canvas_comment change. Return true if the local state
  // was patched from the payload; return false (or throw) to fall back to the
  // debounced refresh. Omit it entirely to always refresh on comment changes.
  onCommentChange?: (
    payload: RealtimePostgresChangesPayload<CommentRealtimeRow>,
  ) => boolean;
  // Surgical patch for a canvas_deck_slide_lock change. Same contract as
  // onCommentChange.
  onLockChange?: (
    payload: RealtimePostgresChangesPayload<LockRealtimeRow>,
  ) => boolean;
  // Surgical patch for a canvas_deck_slide change (another actor's edit, an
  // approved proposal, a restore). Same contract as onCommentChange: return
  // true if patched locally, false/throw to fall back to the debounced refresh.
  // Omit it to always refresh on slide changes (the pre-reducer behaviour).
  onSlideChange?: (
    payload: RealtimePostgresChangesPayload<SlideRealtimeRow>,
  ) => boolean;
};

export function useDeckRealtime(
  deckId: string,
  workspaceId: string | null,
  options: UseDeckRealtimeOptions = {},
) {
  const router = useRouter();
  // Refs let the subscription effect read the freshest router/callbacks
  // without re-binding every render. React 19's lint rule forbids mutating
  // refs during render, so the assignment happens in an effect (which
  // commits before the subscription effect uses it).
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    refreshRef.current = () => router.refresh();
  }, [router]);

  const statusCbRef = useRef<UseDeckRealtimeOptions["onStatusChange"]>(undefined);
  const commentCbRef =
    useRef<UseDeckRealtimeOptions["onCommentChange"]>(undefined);
  const lockCbRef = useRef<UseDeckRealtimeOptions["onLockChange"]>(undefined);
  const slideCbRef = useRef<UseDeckRealtimeOptions["onSlideChange"]>(undefined);
  useEffect(() => {
    statusCbRef.current = options.onStatusChange;
    commentCbRef.current = options.onCommentChange;
    lockCbRef.current = options.onLockChange;
    slideCbRef.current = options.onSlideChange;
  }, [
    options.onStatusChange,
    options.onCommentChange,
    options.onLockChange,
    options.onSlideChange,
  ]);

  useEffect(() => {
    if (!deckId) return;

    const supabase = createClient();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, 400);
    };

    // Run a surgical-patch callback; if it returns false, throws, or isn't
    // wired, fall back to the debounced refresh. Wrapping every patch attempt
    // means a buggy callback can never strand a realtime event — worst case it
    // costs one refresh, the same behaviour as before this hook learned to
    // patch.
    const patchOrRefresh = <T>(
      cb: ((p: T) => boolean) | undefined,
      payload: T,
    ) => {
      if (!cb) {
        scheduleRefresh();
        return;
      }
      let handled = false;
      try {
        handled = cb(payload);
      } catch (err) {
        console.warn("[useDeckRealtime] local patch threw; refreshing", err);
        handled = false;
      }
      if (!handled) scheduleRefresh();
    };

    // One channel per deck. Four filtered table bindings live on it so the
    // websocket carries a single subscription instead of four.
    const channel = supabase
      .channel(`deck-realtime:${deckId}`)
      // Comments: try the surgical patch first (the hot path — a teammate
      // dropping a comment shouldn't re-run the loader under a half-typed
      // reply). Falls back to refresh when the payload can't be resolved
      // locally (unknown author, a resolve/edit we don't patch).
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_comment",
          filter: `deck_id=eq.${deckId}`,
        },
        (payload) =>
          patchOrRefresh(
            commentCbRef.current,
            payload as RealtimePostgresChangesPayload<CommentRealtimeRow>,
          ),
      )
      // Slide rows: try the surgical patch first (a content/version bump on an
      // existing slide folds straight into the local slide list, sparing the
      // ~19-query loader run — this is what makes a fast-lane apply "land" in an
      // open tab without a page re-derivation). Structural changes (insert,
      // delete, reorder) and unresolvable rows fall back to the debounced refresh.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_deck_slide",
          filter: `deck_id=eq.${deckId}`,
        },
        (payload) =>
          patchOrRefresh(
            slideCbRef.current,
            payload as RealtimePostgresChangesPayload<SlideRealtimeRow>,
          ),
      )
      // Proposal lifecycle visibility: when a teammate approves/rejects/
      // withdraws an edit, refresh so the inline review UI stops showing it
      // as pending. Structural (the pending-proposals join), so always refresh.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_deck_edit",
          filter: `deck_id=eq.${deckId}`,
        },
        scheduleRefresh,
      );

    // Locks: surgical patch (acquire/release/renew is a passive pill, cheap to
    // patch and disruptive to refresh). workspace_id is the tightest filter the
    // table allows; the callback drops locks for other decks in the workspace.
    const lockBinding = (
      payload: RealtimePostgresChangesPayload<LockRealtimeRow>,
    ) => patchOrRefresh(lockCbRef.current, payload);

    if (workspaceId) {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_deck_slide_lock",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) =>
          lockBinding(
            payload as RealtimePostgresChangesPayload<LockRealtimeRow>,
          ),
      );
    } else {
      // No workspace id? Subscribe unfiltered — RLS still scopes payloads to
      // tables the user can SELECT, so a non-member sees nothing.
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_deck_slide_lock",
        },
        (payload) =>
          lockBinding(
            payload as RealtimePostgresChangesPayload<LockRealtimeRow>,
          ),
      );
    }

    channel.subscribe((status) => {
      // Bubble every transition up to the parent so it can render a degrade
      // banner on CHANNEL_ERROR / TIMED_OUT and clear it once SUBSCRIBED
      // returns. We still log the bad states for dev tooling.
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[useDeckRealtime] channel status: ${status}`);
      }
      statusCbRef.current?.(status as DeckRealtimeStatus);
    });

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [deckId, workspaceId]);
}
