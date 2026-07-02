import type { CommentRow, SlideRow } from "@/app/canvases/[id]/page";
import type {
  CommentRealtimeRow,
  LockRealtimeRow,
  SlideRealtimeRow,
} from "@/app/canvases/[id]/use-deck-realtime";
import { DRAW_SLIDE_CLASS, DRAW_OVERLAY_CLASS } from "@/lib/canvas/draw/scene";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

// Pure reducers that fold a realtime row into the deck's local comment / lock
// state, so deck-workspace can patch in place instead of re-running the page
// loader (see use-deck-realtime.ts). Kept pure + framework-free so the routing
// decisions ("can this payload be patched locally, or must we refresh?") are
// unit-testable without a live multi-tab websocket.
//
// The central constraint: the realtime WAL row carries the TABLE columns, not
// the page.tsx join. The loader enriches a comment's author_email / author_name
// and a lock's holder email / name from a `users` lookup keyed on the actor's
// id. The realtime row only has that id. So each reducer takes a `resolve`
// function (backed by the cached member roster + the current user) and returns
// `null` — "couldn't resolve locally, please refresh" — when the actor is
// outside the roster (e.g. a guest). A null result is the hook's signal to fall
// back to the debounced router.refresh(), so attribution is never wrong: it's
// either resolved correctly from the roster or deferred to the loader.

// Resolve an actor's (email, name) from their user id. Returns null when the id
// isn't in the roster and isn't the current user — the caller then refreshes.
export type ActorResolver = (
  userId: string | null,
) => { email: string | null; name: string | null } | null;

export type CommentPatchResult =
  | { kind: "patched"; comments: CommentRow[] }
  | { kind: "refresh" };

// Fold a canvas_comment realtime change into the local comment list.
//   INSERT  — append (resolving author identity), unless we already have the id
//             (our own optimistic insert / a duplicate event).
//   UPDATE  — replace the row in place, preserving the existing author identity
//             (the loader-joined fields) since the WAL row doesn't carry it.
//   DELETE  — drop by id (old carries the PK even under default replica identity).
// Returns { kind: "refresh" } whenever the payload can't be applied with correct
// attribution, so the hook refreshes instead.
export function applyCommentRealtime(
  comments: CommentRow[],
  payload: RealtimePostgresChangesPayload<CommentRealtimeRow>,
  resolveAuthor: ActorResolver,
): CommentPatchResult {
  if (payload.eventType === "INSERT") {
    const row = payload.new;
    if (!row || !row.id) return { kind: "refresh" };
    // Already present (our optimistic write echoed back, or a duplicate
    // delivery) — no-op patch, no refresh needed.
    if (comments.some((c) => c.id === row.id)) {
      return { kind: "patched", comments };
    }
    // Claude-authored rows have no user identity to resolve (author_id is null);
    // a user row needs its author resolved from the roster; a client row (a
    // public-link guest, 0064) carries its own stored attribution in the WAL
    // row — no roster lookup, no refresh.
    let email: string | null = null;
    let name: string | null = null;
    if (row.author_kind === "user") {
      const who = resolveAuthor(row.author_id);
      if (!who) return { kind: "refresh" };
      email = who.email;
      name = who.name;
    } else if (row.author_kind === "client") {
      email = row.author_email ?? null;
      name = row.author_name ?? null;
    }
    const next: CommentRow = {
      id: row.id,
      deck_id: row.deck_id,
      slide_id: row.slide_id,
      parent_id: row.parent_id,
      body: row.body,
      author_id: row.author_id,
      author_kind: row.author_kind,
      author_email: email,
      author_name: name,
      anchor_x: row.anchor_x,
      anchor_y: row.anchor_y,
      resolved: row.resolved,
      resolved_at: row.resolved_at,
      created_at: row.created_at,
    };
    return { kind: "patched", comments: [...comments, next] };
  }

  if (payload.eventType === "UPDATE") {
    const row = payload.new;
    if (!row || !row.id) return { kind: "refresh" };
    const idx = comments.findIndex((c) => c.id === row.id);
    // An update to a comment we don't have locally (filtered out, or arrived
    // before its insert) — refresh to reconcile.
    if (idx === -1) return { kind: "refresh" };
    const prev = comments[idx];
    // Replace the mutable fields from the WAL row; keep the loader-joined author
    // identity (the WAL row doesn't carry email/name).
    const updated: CommentRow = {
      ...prev,
      body: row.body,
      slide_id: row.slide_id,
      parent_id: row.parent_id,
      anchor_x: row.anchor_x,
      anchor_y: row.anchor_y,
      resolved: row.resolved,
      resolved_at: row.resolved_at,
    };
    const nextComments = comments.slice();
    nextComments[idx] = updated;
    return { kind: "patched", comments: nextComments };
  }

  if (payload.eventType === "DELETE") {
    const id = payload.old?.id;
    if (!id) return { kind: "refresh" };
    // Removing a root drops its replies in the DB (ON DELETE CASCADE), but each
    // cascaded child emits its own DELETE event, so we only remove the one id
    // here and let the sibling events clear the rest.
    if (!comments.some((c) => c.id === id)) {
      // Already gone locally — nothing to do, no refresh.
      return { kind: "patched", comments };
    }
    return { kind: "patched", comments: comments.filter((c) => c.id !== id) };
  }

  return { kind: "refresh" };
}

export type SlidePatchResult =
  | { kind: "patched"; slides: SlideRow[] }
  // The surgical patch landed (current_version_id is applied synchronously so
  // the preview remounts on the new key), but current_version_no — a version-
  // table join the WAL row can't carry — is now stale on the patched row. The
  // caller applies these slides AND schedules a loader refresh to re-derive it.
  | { kind: "patched-refresh"; slides: SlideRow[] }
  | { kind: "refresh" };

// Fold a canvas_deck_slide realtime UPDATE into the deck's slide rows, so an
// edit landing from ANOTHER actor (a teammate, an approved proposal, a
// fast-lane apply, a restore) converges this tab's preview WITHOUT waiting on
// the page loader. The remount signature keys on current_version_id (also on
// the WAL row), so patching it here lets the preview iframe reload the new
// content immediately — the patch drives the remount, not a loader run.
//
// We patch ONLY the columns the WAL row reliably carries and that feed the
// list/preview/permission state: title, owner_id, current_version_id, and the
// drawn/overlay marker flags (derived from html_body — a TOASTed column the
// row omits when the UPDATE didn't touch it, so the flags fall back to their
// previous values then). Anything the row can't settle correctly falls back
// to a refresh:
//   • INSERT / DELETE            — structural (a slide appeared/vanished); the
//                                  loader re-derives ordering + counts.
//   • a POSITION change          — a reorder touches the whole set; patching one
//                                  row's position would desync the rest.
//   • an unknown slide id        — not in our local list (added elsewhere).
// A current_version_id BUMP is patched in place AND paired with a refresh
// (kind 'patched-refresh'): current_version_no is a version-table join the WAL
// row can't carry, and it is NOT cosmetic — the member-propose staleness gate
// bases on it (deck-workspace → proposeSlideHtmlEdit) and the slide badge shows
// it, so a stale number here misfires a "this slide changed since you started
// editing" rejection. The id lands synchronously (instant preview converge);
// the debounced loader refresh reconciles the number and pending_proposals (an
// edits join also absent from the WAL row). Non-version changes (title/owner/
// draw flags) settle fully in place with no refresh.
export function applySlideRealtime(
  slides: SlideRow[],
  payload: RealtimePostgresChangesPayload<SlideRealtimeRow>,
): SlidePatchResult {
  // A new or removed slide reshapes the deck — let the loader re-derive.
  if (payload.eventType !== "UPDATE") return { kind: "refresh" };

  const row = payload.new;
  if (!row || !row.id) return { kind: "refresh" };
  const idx = slides.findIndex((s) => s.id === row.id);
  if (idx === -1) return { kind: "refresh" };

  const prev = slides[idx];
  // A position move is a reorder — the sibling rows moved too; refresh so the
  // whole ordering stays consistent.
  if (typeof row.position === "number" && row.position !== prev.position) {
    return { kind: "refresh" };
  }

  const htmlKnown = typeof row.html_body === "string";
  const html = htmlKnown ? (row.html_body as string) : "";
  const updated: SlideRow = {
    ...prev,
    title: row.title ?? "",
    // null is meaningful (unowned slide), so only an absent column keeps prev.
    owner_id: "owner_id" in row ? row.owner_id : prev.owner_id,
    current_version_id: row.current_version_id ?? prev.current_version_id,
    // Quote-anchored to mirror the loader's `%CLASS"%` ilike, so the two
    // derivations agree on a slide whose text merely MENTIONS the class name.
    is_drawn: htmlKnown ? html.includes(`${DRAW_SLIDE_CLASS}"`) : prev.is_drawn,
    has_overlay: htmlKnown
      ? html.includes(`${DRAW_OVERLAY_CLASS}"`)
      : prev.has_overlay,
  };
  const versionChanged = updated.current_version_id !== prev.current_version_id;
  // No-op if nothing the list/preview keys on actually changed (a duplicate
  // delivery, or an UPDATE to a column we don't track) — don't churn state.
  if (
    updated.title === prev.title &&
    updated.owner_id === prev.owner_id &&
    !versionChanged &&
    updated.is_drawn === prev.is_drawn &&
    updated.has_overlay === prev.has_overlay
  ) {
    return { kind: "patched", slides };
  }
  const next = slides.slice();
  next[idx] = updated;
  // A version bump leaves current_version_no stale on the patched row (the WAL
  // row can't carry that join). Land the id synchronously so the preview
  // remounts, but ask the caller to also refresh so the loader re-derives the
  // number the member-propose gate + badge read. See the header note.
  if (versionChanged) return { kind: "patched-refresh", slides: next };
  return { kind: "patched", slides: next };
}

export type LockPatchResult =
  | { kind: "patched"; slides: SlideRow[] }
  | { kind: "refresh" }
  | { kind: "ignore" }; // a lock for another deck in the workspace — no-op

// Fold a canvas_deck_slide_lock realtime change into the deck's slide rows
// (each SlideRow carries its active `lock`). The lock table has no deck_id, so
// the filter is workspace-wide; a lock whose slide_id isn't in THIS deck is
// ignored (kind: "ignore" — neither patch nor refresh).
//   INSERT / UPDATE — set/replace the slide's lock (resolving the holder).
//   DELETE          — clear the slide's lock (release / expiry sweep).
// Returns { kind: "refresh" } when the holder can't be resolved from the roster,
// so the loader fills in the correct name.
export function applyLockRealtime(
  slides: SlideRow[],
  payload: RealtimePostgresChangesPayload<LockRealtimeRow>,
  resolveHolder: ActorResolver,
): LockPatchResult {
  const slideId =
    payload.eventType === "DELETE"
      ? payload.old?.slide_id
      : payload.new?.slide_id;
  if (!slideId) return { kind: "refresh" };

  const idx = slides.findIndex((s) => s.id === slideId);
  // Not a slide in this deck (the workspace-wide filter over-fires) — ignore.
  if (idx === -1) return { kind: "ignore" };

  if (payload.eventType === "DELETE") {
    if (slides[idx].lock == null) return { kind: "patched", slides }; // already clear
    const next = slides.slice();
    next[idx] = { ...next[idx], lock: null };
    return { kind: "patched", slides: next };
  }

  // INSERT or UPDATE — claim / renew.
  const row = payload.new;
  if (!row || !row.locked_by || !row.expires_at) return { kind: "refresh" };
  const who = resolveHolder(row.locked_by);
  if (!who) return { kind: "refresh" };
  const prev = slides[idx].lock;
  // No-op if nothing the UI shows actually changed (same holder + expiry) — a
  // duplicate delivery shouldn't churn React state.
  if (
    prev &&
    prev.locked_by === row.locked_by &&
    prev.locked_by_kind === row.locked_by_kind &&
    prev.expires_at === row.expires_at
  ) {
    return { kind: "patched", slides };
  }
  const next = slides.slice();
  next[idx] = {
    ...next[idx],
    lock: {
      locked_by: row.locked_by,
      locked_by_kind: row.locked_by_kind === "agent" ? "agent" : "user",
      expires_at: row.expires_at,
      user_email: who.email,
      user_name: who.name,
    },
  };
  return { kind: "patched", slides: next };
}
