import { describe, expect, it } from "vitest";
import {
  applyCommentRealtime,
  applyLockRealtime,
  applySlideRealtime,
  type ActorResolver,
} from "../src/lib/canvas/realtime-patch";
import type { CommentRow, SlideRow } from "../src/app/canvases/[id]/page";
import type {
  CommentRealtimeRow,
  LockRealtimeRow,
  SlideRealtimeRow,
} from "../src/app/canvases/[id]/use-deck-realtime";
import { DRAW_OVERLAY_CLASS, DRAW_SLIDE_CLASS } from "../src/lib/canvas/draw/scene";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

// Unit coverage for the surgical-realtime reducers. Live multi-tab realtime
// can't be exercised here, so these lock in the ROUTING decision the live hook
// depends on: which payloads patch locally (and how) vs. which return "refresh"
// so useDeckRealtime falls back to router.refresh(). The enrichment constraint
// — the WAL row carries no author/holder email or name — is the crux: a comment
// from a roster member resolves locally; one from outside the roster defers.

const ROSTER: Record<string, { email: string | null; name: string | null }> = {
  "user-self": { email: "self@acme.com", name: "Self User" },
  "user-mate": { email: "mate@acme.com", name: "Team Mate" },
};
const resolve: ActorResolver = (id) => (id ? ROSTER[id] ?? null : null);

function comment(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: "c1",
    deck_id: "deck-1",
    slide_id: "slide-1",
    parent_id: null,
    body: "hello",
    author_id: "user-mate",
    author_kind: "user",
    author_email: "mate@acme.com",
    author_name: "Team Mate",
    anchor_x: null,
    anchor_y: null,
    resolved: false,
    resolved_at: null,
    created_at: "2026-06-21T00:00:00Z",
    ...over,
  };
}

function commentRow(over: Partial<CommentRealtimeRow> = {}): CommentRealtimeRow {
  return {
    id: "c2",
    deck_id: "deck-1",
    slide_id: "slide-1",
    parent_id: null,
    body: "new comment",
    author_kind: "user",
    author_id: "user-mate",
    author_name: null,
    author_email: null,
    anchor_x: null,
    anchor_y: null,
    resolved: false,
    resolved_at: null,
    created_at: "2026-06-21T01:00:00Z",
    ...over,
  };
}

function insertComment(
  row: CommentRealtimeRow,
): RealtimePostgresChangesPayload<CommentRealtimeRow> {
  return {
    eventType: "INSERT",
    schema: "public",
    table: "canvas_comment",
    commit_timestamp: "",
    errors: [],
    new: row,
    old: {},
  } as RealtimePostgresChangesPayload<CommentRealtimeRow>;
}

function updateComment(
  row: CommentRealtimeRow,
): RealtimePostgresChangesPayload<CommentRealtimeRow> {
  return {
    eventType: "UPDATE",
    schema: "public",
    table: "canvas_comment",
    commit_timestamp: "",
    errors: [],
    new: row,
    old: { id: row.id },
  } as RealtimePostgresChangesPayload<CommentRealtimeRow>;
}

function deleteComment(
  id: string,
): RealtimePostgresChangesPayload<CommentRealtimeRow> {
  return {
    eventType: "DELETE",
    schema: "public",
    table: "canvas_comment",
    commit_timestamp: "",
    errors: [],
    new: {},
    old: { id },
  } as RealtimePostgresChangesPayload<CommentRealtimeRow>;
}

describe("applyCommentRealtime — INSERT", () => {
  it("appends a comment from a roster member with resolved attribution", () => {
    const res = applyCommentRealtime([comment()], insertComment(commentRow()), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments).toHaveLength(2);
    const added = res.comments[1];
    expect(added.id).toBe("c2");
    expect(added.author_email).toBe("mate@acme.com");
    expect(added.author_name).toBe("Team Mate");
  });

  it("defers to refresh when the author isn't in the roster (a guest)", () => {
    const res = applyCommentRealtime(
      [comment()],
      insertComment(commentRow({ id: "c3", author_id: "user-guest" })),
      resolve,
    );
    expect(res.kind).toBe("refresh");
  });

  it("appends a Claude-authored comment without needing roster resolution", () => {
    const res = applyCommentRealtime(
      [],
      insertComment(
        commentRow({ id: "c4", author_kind: "claude", author_id: null }),
      ),
      resolve,
    );
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments[0].author_kind).toBe("claude");
    expect(res.comments[0].author_email).toBeNull();
  });

  it("appends a client (public-link guest) comment using its stored attribution", () => {
    const res = applyCommentRealtime(
      [],
      insertComment(
        commentRow({
          id: "c6",
          author_kind: "client",
          author_id: null,
          author_name: "Ana Prospect",
          author_email: "ana@client.com",
        }),
      ),
      resolve,
    );
    // A guest is outside the roster, but the WAL row carries its own
    // attribution (0064) — must patch locally, never refresh.
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments[0].author_kind).toBe("client");
    expect(res.comments[0].author_name).toBe("Ana Prospect");
    expect(res.comments[0].author_email).toBe("ana@client.com");
  });

  it("is a no-op (no duplicate, no refresh) when the id is already present", () => {
    const existing = [comment({ id: "c2" })];
    const res = applyCommentRealtime(existing, insertComment(commentRow({ id: "c2" })), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    // Same array reference back — the caller skips the setState.
    expect(res.comments).toBe(existing);
  });

  it("preserves the deck-level (null slide_id) shape on insert", () => {
    const res = applyCommentRealtime(
      [],
      insertComment(commentRow({ id: "c5", slide_id: null })),
      resolve,
    );
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments[0].slide_id).toBeNull();
  });
});

describe("applyCommentRealtime — UPDATE", () => {
  it("patches a resolve toggle in place, keeping the loader-joined author", () => {
    const existing = [comment({ id: "c2", resolved: false })];
    const res = applyCommentRealtime(
      existing,
      updateComment(commentRow({ id: "c2", resolved: true, resolved_at: "2026-06-21T02:00:00Z" })),
      resolve,
    );
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments[0].resolved).toBe(true);
    expect(res.comments[0].resolved_at).toBe("2026-06-21T02:00:00Z");
    // Author identity (which the WAL row doesn't carry) is preserved from the
    // prior loader-joined row.
    expect(res.comments[0].author_name).toBe("Team Mate");
  });

  it("refreshes when updating a comment not present locally", () => {
    const res = applyCommentRealtime(
      [comment({ id: "c1" })],
      updateComment(commentRow({ id: "absent" })),
      resolve,
    );
    expect(res.kind).toBe("refresh");
  });
});

describe("applyCommentRealtime — DELETE", () => {
  it("removes the comment by id (PK travels in old even under default replica identity)", () => {
    const existing = [comment({ id: "c1" }), comment({ id: "c2" })];
    const res = applyCommentRealtime(existing, deleteComment("c1"), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments.map((c) => c.id)).toEqual(["c2"]);
  });

  it("is a no-op when the id is already gone (cascaded sibling already removed it)", () => {
    const existing = [comment({ id: "c2" })];
    const res = applyCommentRealtime(existing, deleteComment("c1"), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.comments).toBe(existing);
  });

  it("refreshes when the delete payload has no id", () => {
    const res = applyCommentRealtime(
      [comment()],
      {
        eventType: "DELETE",
        schema: "public",
        table: "canvas_comment",
        commit_timestamp: "",
        errors: [],
        new: {},
        old: {},
      } as RealtimePostgresChangesPayload<CommentRealtimeRow>,
      resolve,
    );
    expect(res.kind).toBe("refresh");
  });
});

// ---- locks ----------------------------------------------------------------

function slide(over: Partial<SlideRow> = {}): SlideRow {
  return {
    id: "slide-1",
    position: 0,
    title: "A",
    owner_id: null,
    current_version_id: "v1",
    current_version_no: 1,
    lock: null,
    pending_proposals: 0,
    is_drawn: false,
    has_overlay: false,
    ...over,
  };
}

function lockRow(over: Partial<LockRealtimeRow> = {}): LockRealtimeRow {
  return {
    slide_id: "slide-1",
    workspace_id: "ws-1",
    locked_by: "user-mate",
    locked_by_kind: "user",
    acquired_at: "2026-06-21T00:00:00Z",
    expires_at: "2026-06-21T00:15:00Z",
    ...over,
  };
}

function insertLock(
  row: LockRealtimeRow,
): RealtimePostgresChangesPayload<LockRealtimeRow> {
  return {
    eventType: "INSERT",
    schema: "public",
    table: "canvas_deck_slide_lock",
    commit_timestamp: "",
    errors: [],
    new: row,
    old: {},
  } as RealtimePostgresChangesPayload<LockRealtimeRow>;
}

function deleteLock(
  slideId: string,
): RealtimePostgresChangesPayload<LockRealtimeRow> {
  return {
    eventType: "DELETE",
    schema: "public",
    table: "canvas_deck_slide_lock",
    commit_timestamp: "",
    errors: [],
    new: {},
    old: { slide_id: slideId },
  } as RealtimePostgresChangesPayload<LockRealtimeRow>;
}

describe("applyLockRealtime — acquire / renew", () => {
  it("sets the slide's lock with the holder resolved from the roster", () => {
    const res = applyLockRealtime([slide()], insertLock(lockRow()), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides[0].lock).toEqual({
      locked_by: "user-mate",
      locked_by_kind: "user",
      expires_at: "2026-06-21T00:15:00Z",
      user_email: "mate@acme.com",
      user_name: "Team Mate",
    });
  });

  it("refreshes when the holder isn't in the roster", () => {
    const res = applyLockRealtime(
      [slide()],
      insertLock(lockRow({ locked_by: "user-guest" })),
      resolve,
    );
    expect(res.kind).toBe("refresh");
  });

  it("ignores a lock for a slide not in this deck (workspace-wide filter over-fires)", () => {
    const res = applyLockRealtime(
      [slide({ id: "slide-1" })],
      insertLock(lockRow({ slide_id: "other-deck-slide" })),
      resolve,
    );
    expect(res.kind).toBe("ignore");
  });

  it("is a no-op when holder + expiry are unchanged (duplicate delivery)", () => {
    const existing = [
      slide({
        lock: {
          locked_by: "user-mate",
          locked_by_kind: "user",
          expires_at: "2026-06-21T00:15:00Z",
          user_email: "mate@acme.com",
          user_name: "Team Mate",
        },
      }),
    ];
    const res = applyLockRealtime(existing, insertLock(lockRow()), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides).toBe(existing); // same reference → no churn
  });

  it("patches a renewed expiry (same holder, new expires_at)", () => {
    const existing = [
      slide({
        lock: {
          locked_by: "user-mate",
          locked_by_kind: "user",
          expires_at: "2026-06-21T00:15:00Z",
          user_email: "mate@acme.com",
          user_name: "Team Mate",
        },
      }),
    ];
    const res = applyLockRealtime(
      existing,
      insertLock(lockRow({ expires_at: "2026-06-21T00:30:00Z" })),
      resolve,
    );
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides[0].lock?.expires_at).toBe("2026-06-21T00:30:00Z");
  });
});

describe("applyLockRealtime — release / expiry", () => {
  it("clears the slide's lock on DELETE (PK travels in old)", () => {
    const existing = [
      slide({
        lock: {
          locked_by: "user-mate",
          locked_by_kind: "user",
          expires_at: "2026-06-21T00:15:00Z",
          user_email: "mate@acme.com",
          user_name: "Team Mate",
        },
      }),
    ];
    const res = applyLockRealtime(existing, deleteLock("slide-1"), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides[0].lock).toBeNull();
  });

  it("is a no-op when the lock is already clear", () => {
    const existing = [slide({ lock: null })];
    const res = applyLockRealtime(existing, deleteLock("slide-1"), resolve);
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides).toBe(existing);
  });

  it("ignores a release for a slide outside this deck", () => {
    const res = applyLockRealtime([slide()], deleteLock("other"), resolve);
    expect(res.kind).toBe("ignore");
  });
});

// ── canvas_deck_slide reducer (speed #5.3) ──────────────────────────────────
function slideRow(over: Partial<SlideRealtimeRow> = {}): SlideRealtimeRow {
  return {
    id: "slide-1",
    deck_id: "deck-1",
    position: 0,
    title: "A",
    html_body: '<section class="slide">A</section>',
    slide_styles: null,
    owner_id: null,
    current_version_id: "v1",
    ...over,
  };
}

function slideUpdate(
  next: SlideRealtimeRow,
): RealtimePostgresChangesPayload<SlideRealtimeRow> {
  return {
    eventType: "UPDATE",
    new: next,
    old: {},
    schema: "public",
    table: "canvas_deck_slide",
    commit_timestamp: "",
    errors: [],
  } as unknown as RealtimePostgresChangesPayload<SlideRealtimeRow>;
}

describe("applySlideRealtime", () => {
  it("patches a version bump in place and asks for a refresh (current_version_no is stale)", () => {
    const res = applySlideRealtime(
      [slide({ current_version_id: "v1" })],
      slideUpdate(slideRow({ current_version_id: "v2", title: "A2" })),
    );
    // The id lands synchronously (drives the remount) but the WAL row can't
    // carry current_version_no, so the reducer pairs the patch with a refresh.
    expect(res.kind).toBe("patched-refresh");
    if (res.kind === "refresh") return;
    expect(res.slides[0].current_version_id).toBe("v2");
    expect(res.slides[0].title).toBe("A2");
  });

  it("derives is_drawn / has_overlay from the WAL html_body", () => {
    const res = applySlideRealtime(
      [slide()],
      slideUpdate(
        slideRow({
          current_version_id: "v2",
          html_body: `<section class="slide">A<svg class="${DRAW_OVERLAY_CLASS}"></svg></section>`,
        }),
      ),
    );
    // Version bumped (v1 → v2), so patched-refresh; the flag still derives.
    expect(res.kind).toBe("patched-refresh");
    if (res.kind === "refresh") return;
    expect(res.slides[0].has_overlay).toBe(true);
  });

  it("refreshes on a position change (a reorder needs the whole set)", () => {
    const res = applySlideRealtime(
      [slide({ position: 0 })],
      slideUpdate(slideRow({ position: 3, current_version_id: "v2" })),
    );
    expect(res.kind).toBe("refresh");
  });

  it("refreshes for a slide not in the local list (added elsewhere)", () => {
    const res = applySlideRealtime(
      [slide({ id: "slide-1" })],
      slideUpdate(slideRow({ id: "slide-9" })),
    );
    expect(res.kind).toBe("refresh");
  });

  it("refreshes on INSERT / DELETE (structural)", () => {
    const insert = {
      ...slideUpdate(slideRow()),
      eventType: "INSERT",
    } as unknown as RealtimePostgresChangesPayload<SlideRealtimeRow>;
    expect(applySlideRealtime([slide()], insert).kind).toBe("refresh");
  });

  it("is a no-op when nothing the list/preview keys on changed", () => {
    const existing = [slide({ title: "A", current_version_id: "v1" })];
    const res = applySlideRealtime(
      existing,
      slideUpdate(slideRow({ title: "A", current_version_id: "v1" })),
    );
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides).toBe(existing);
  });

  it("leaves current_version_no as-is on the patched row (the refresh reconciles it)", () => {
    const res = applySlideRealtime(
      [slide({ current_version_no: 7, current_version_id: "v1" })],
      slideUpdate(slideRow({ current_version_id: "v2" })),
    );
    // A version bump is patched-refresh: the id lands now, but the number stays
    // 7 on this row until the paired loader refresh re-derives it.
    expect(res.kind).toBe("patched-refresh");
    if (res.kind === "refresh") return;
    expect(res.slides[0].current_version_no).toBe(7);
  });

  it("patches an owner_id change (it feeds the direct-edit permission gate)", () => {
    const res = applySlideRealtime(
      [slide({ owner_id: null })],
      slideUpdate(slideRow({ owner_id: "user-mate" })),
    );
    // Must be a real patch (new array), not the untracked-column no-op —
    // otherwise an ownership assignment is silently dropped on open tabs.
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides[0].owner_id).toBe("user-mate");
  });

  it("patches a title-only change as plain 'patched' — no refresh without a version bump", () => {
    const res = applySlideRealtime(
      [slide({ title: "Old", current_version_id: "v1" })],
      slideUpdate(slideRow({ title: "New title", current_version_id: "v1" })),
    );
    // A rename touches no version-table join, so it settles fully in place; the
    // refresh is reserved for the current_version_id bump (current_version_no is
    // then stale). Pairs with the version-bump test above, which asserts the
    // combined version+title change is 'patched-refresh' with both fields.
    expect(res.kind).toBe("patched");
    if (res.kind !== "patched") return;
    expect(res.slides[0].title).toBe("New title");
    expect(res.slides[0].current_version_id).toBe("v1");
  });

  it("does not flag a slide whose text merely mentions the drawn class", () => {
    const res = applySlideRealtime(
      [slide()],
      slideUpdate(
        slideRow({
          current_version_id: "v2",
          // Quote-anchored match, mirroring the loader's `%CLASS"%` ilike.
          html_body: `<section class="slide">docs about ${DRAW_SLIDE_CLASS} slides</section>`,
        }),
      ),
    );
    expect(res.kind).toBe("patched-refresh");
    if (res.kind === "refresh") return;
    expect(res.slides[0].is_drawn).toBe(false);
  });

  it("keeps the previous drawn/overlay flags when the WAL row omits html_body (unchanged TOAST)", () => {
    const row = slideRow({ current_version_id: "v2" });
    delete (row as Partial<SlideRealtimeRow>).html_body;
    const res = applySlideRealtime(
      [slide({ is_drawn: true, has_overlay: true })],
      slideUpdate(row),
    );
    expect(res.kind).toBe("patched-refresh");
    if (res.kind === "refresh") return;
    // An UPDATE that didn't touch html_body must not un-flag a drawn slide.
    expect(res.slides[0].is_drawn).toBe(true);
    expect(res.slides[0].has_overlay).toBe(true);
    expect(res.slides[0].current_version_id).toBe("v2");
  });
});
