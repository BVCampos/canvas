// Tests for the pure notification helpers (lib/canvas/notifications).
//
// These lock in the WHO + HOW-MANY decisions the @mention feed (migration
// 0048) depends on, with no DB: which recipients a comment notifies (exclude
// the author, dedupe, mention-beats-reply), and the read-time projections the
// badge + feed read back (unread count, mark-all target ids, preview trim).

import { describe, expect, it } from "vitest";
import {
  notificationsForClientComment,
  notificationsForComment,
  previewOf,
  unreadCount,
  unreadIds,
  type CommentNotificationContext,
  type NotificationRow,
} from "../src/lib/canvas/notifications";

function ctx(over: Partial<CommentNotificationContext>): CommentNotificationContext {
  return {
    workspaceId: "ws1",
    deckId: "deck1",
    slideId: "slide1",
    commentId: "c1",
    actorId: "author",
    body: "hello team",
    mentionedUserIds: [],
    parentAuthorId: null,
    ...over,
  };
}

describe("notificationsForComment", () => {
  it("emits one mention per resolved mentioned user", () => {
    const out = notificationsForComment(
      ctx({ mentionedUserIds: ["alice", "bob"] }),
    );
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.user_id)).toEqual(["alice", "bob"]);
    expect(out.every((n) => n.kind === "mention")).toBe(true);
    expect(out.every((n) => n.actor_id === "author")).toBe(true);
  });

  it("never notifies the author about their own mention", () => {
    const out = notificationsForComment(
      ctx({ actorId: "author", mentionedUserIds: ["author", "alice"] }),
    );
    expect(out.map((n) => n.user_id)).toEqual(["alice"]);
  });

  it("dedupes a user mentioned twice", () => {
    const out = notificationsForComment(
      ctx({ mentionedUserIds: ["alice", "alice"] }),
    );
    expect(out.map((n) => n.user_id)).toEqual(["alice"]);
  });

  it("emits a comment_reply to the parent author on a reply", () => {
    const out = notificationsForComment(
      ctx({ mentionedUserIds: [], parentAuthorId: "carol" }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("comment_reply");
    expect(out[0].user_id).toBe("carol");
  });

  it("does not reply-notify the author replying to their own thread", () => {
    const out = notificationsForComment(
      ctx({ actorId: "author", parentAuthorId: "author" }),
    );
    expect(out).toEqual([]);
  });

  it("a mention beats a reply for the same user (one row, mention wins)", () => {
    // Reply to carol's thread AND @carol — she should get a single 'mention',
    // the stronger signal, not a mention + a reply.
    const out = notificationsForComment(
      ctx({ mentionedUserIds: ["carol"], parentAuthorId: "carol" }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("mention");
    expect(out[0].user_id).toBe("carol");
  });

  it("combines a mention and a distinct reply recipient", () => {
    const out = notificationsForComment(
      ctx({ mentionedUserIds: ["alice"], parentAuthorId: "carol" }),
    );
    expect(out).toHaveLength(2);
    expect(out.find((n) => n.user_id === "alice")?.kind).toBe("mention");
    expect(out.find((n) => n.user_id === "carol")?.kind).toBe("comment_reply");
  });

  it("carries the deck/slide/comment refs and a body preview onto each row", () => {
    const out = notificationsForComment(
      ctx({
        deckId: "deckX",
        slideId: "slideY",
        commentId: "cZ",
        body: "  great   work\n  on  this  ",
        mentionedUserIds: ["alice"],
      }),
    );
    expect(out[0]).toMatchObject({
      deck_id: "deckX",
      slide_id: "slideY",
      comment_id: "cZ",
      body_preview: "great work on this",
    });
  });

  it("returns nothing when there is no one to notify", () => {
    expect(notificationsForComment(ctx({}))).toEqual([]);
  });
});

describe("previewOf", () => {
  it("collapses whitespace to a single line", () => {
    expect(previewOf("a\n\n  b   c")).toBe("a b c");
  });

  it("truncates long bodies with an ellipsis", () => {
    const long = "x".repeat(300);
    const out = previewOf(long);
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short body intact", () => {
    expect(previewOf("short note")).toBe("short note");
  });
});

describe("unreadCount", () => {
  it("counts only rows with a null read_at", () => {
    expect(
      unreadCount([
        { read_at: null },
        { read_at: "2026-01-01T00:00:00Z" },
        { read_at: null },
      ]),
    ).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(unreadCount([])).toBe(0);
  });
});

describe("unreadIds", () => {
  it("returns only the still-unread ids", () => {
    const rows: NotificationRow[] = [
      { id: "1", kind: "mention", read_at: null },
      { id: "2", kind: "mention", read_at: "2026-01-01T00:00:00Z" },
      { id: "3", kind: "comment_reply", read_at: null },
    ];
    expect(unreadIds(rows)).toEqual(["1", "3"]);
  });

  it("is empty when everything is read", () => {
    const rows: NotificationRow[] = [
      { id: "1", kind: "mention", read_at: "2026-01-01T00:00:00Z" },
    ];
    expect(unreadIds(rows)).toEqual([]);
  });
});

describe("notificationsForClientComment", () => {
  it("notifies each recipient once with the guest's name in the preview", () => {
    const out = notificationsForClientComment({
      workspaceId: "ws",
      deckId: "deck",
      slideId: "slide",
      commentId: "comment",
      authorName: "Ana Prospect",
      body: "The chart on this slide is outdated.",
      recipientIds: ["owner", "editor", "owner"], // duplicate collapses
    });
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.user_id)).toEqual(["owner", "editor"]);
    for (const n of out) {
      expect(n.kind).toBe("client_comment");
      expect(n.actor_id).toBeNull();
      expect(n.body_preview).toContain("Ana Prospect:");
      expect(n.comment_id).toBe("comment");
    }
  });

  it("produces nothing for an empty recipient set", () => {
    expect(
      notificationsForClientComment({
        workspaceId: "ws",
        deckId: "deck",
        slideId: null,
        commentId: "comment",
        authorName: "Ana",
        body: "hi",
        recipientIds: [],
      }),
    ).toEqual([]);
  });
});
