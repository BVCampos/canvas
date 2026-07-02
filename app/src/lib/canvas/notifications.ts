// Pure helpers for the in-app @mention notification feed (migration 0048).
//
// These are the DB-free pieces of the feature so they're unit-testable without
// a Supabase connection: who actually gets notified for a comment (resolve a
// comment's resolved mention set + parent author into recipients, never the
// actor), and the small read-time projections the topbar badge + feed page
// need (unread count, "mark all read" target set). Everything that touches the
// database (the insert, the RLS-gated reads) lives in the server action /
// page; this module just decides WHO and HOW MANY.

// One notification we intend to write. Mirrors the canvas_notification columns
// the logger fills in (the table also defaults id/created_at and leaves
// read_at null). `kind` is the same enum the migration constrains.
export type NotificationKind =
  | "mention"
  | "comment_reply"
  | "proposal_waiting"
  | "proposal_applied"
  | "proposal_rejected"
  | "client_comment";

export type NotificationInsert = {
  workspace_id: string;
  user_id: string; // recipient
  actor_id: string | null; // who caused it (the comment author)
  kind: NotificationKind;
  deck_id: string | null;
  slide_id: string | null;
  comment_id: string | null;
  edit_id: string | null;
  body_preview: string | null;
};

// Inputs the comment write already has on hand. `mentionedUserIds` is the
// resolved set createComment computed against workspace members;
// `parentAuthorId` is the author of the comment being replied to (null for a
// root comment, or when it couldn't be resolved).
export type CommentNotificationContext = {
  workspaceId: string;
  deckId: string | null;
  slideId: string | null;
  commentId: string;
  actorId: string; // the comment author — never notified about their own comment
  body: string;
  mentionedUserIds: string[];
  parentAuthorId: string | null;
};

// Trim a comment body down to a feed-friendly preview. Single-lined and
// length-capped so a long comment doesn't bloat the notification row or the
// feed list. Mirrors the spirit of usage/log's MAX_STRING_LEN cap.
const PREVIEW_MAX_LEN = 140;

export function previewOf(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_MAX_LEN
    ? `${oneLine.slice(0, PREVIEW_MAX_LEN - 1)}…`
    : oneLine;
}

// Decide every notification a single comment should produce.
//
// Rules:
//   * One 'mention' per resolved mentioned user, EXCLUDING the author (you
//     don't get notified for @-ing yourself — matches "don't notify yourself").
//   * One 'comment_reply' to the parent comment's author when this is a reply,
//     UNLESS that author is the actor (replying to your own thread) or is also
//     in the mention set (a mention is the stronger signal — dedupe to one row
//     so a "@alice thanks" reply to alice's comment yields a single mention,
//     not a mention + a reply).
//   * A recipient appears at most once across the whole result.
//
// Returns the rows ready to insert; the caller stamps nothing else.
export function notificationsForComment(
  ctx: CommentNotificationContext,
): NotificationInsert[] {
  const preview = previewOf(ctx.body);
  const out: NotificationInsert[] = [];
  const seen = new Set<string>([ctx.actorId]); // author never notifies self

  for (const userId of ctx.mentionedUserIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({
      workspace_id: ctx.workspaceId,
      user_id: userId,
      actor_id: ctx.actorId,
      kind: "mention",
      deck_id: ctx.deckId,
      slide_id: ctx.slideId,
      comment_id: ctx.commentId,
      edit_id: null,
      body_preview: preview,
    });
  }

  // Reply notification to the thread's author, when distinct from everyone
  // already covered (the actor, and anyone mentioned above).
  if (ctx.parentAuthorId && !seen.has(ctx.parentAuthorId)) {
    seen.add(ctx.parentAuthorId);
    out.push({
      workspace_id: ctx.workspaceId,
      user_id: ctx.parentAuthorId,
      actor_id: ctx.actorId,
      kind: "comment_reply",
      deck_id: ctx.deckId,
      slide_id: ctx.slideId,
      comment_id: ctx.commentId,
      edit_id: null,
      body_preview: preview,
    });
  }

  return out;
}

// Inputs for a CLIENT comment (author_kind='client', no auth user). Unlike
// member comments there is no actor user_id to exclude and no mention set —
// the recipients are the deck's people, resolved by the caller (owner +
// explicit deck members). The client's unverified display name travels in
// the body preview because the feed resolves actor names from actor_id,
// which is null here.
export type ClientCommentNotificationContext = {
  workspaceId: string;
  deckId: string;
  slideId: string | null;
  commentId: string;
  authorName: string;
  body: string;
  recipientIds: string[];
};

export function notificationsForClientComment(
  ctx: ClientCommentNotificationContext,
): NotificationInsert[] {
  const preview = previewOf(`${ctx.authorName}: ${ctx.body}`);
  const out: NotificationInsert[] = [];
  const seen = new Set<string>();
  for (const userId of ctx.recipientIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({
      workspace_id: ctx.workspaceId,
      user_id: userId,
      actor_id: null,
      kind: "client_comment",
      deck_id: ctx.deckId,
      slide_id: ctx.slideId,
      comment_id: ctx.commentId,
      edit_id: null,
      body_preview: preview,
    });
  }
  return out;
}

// A notification as the feed + badge read it back. A subset of the table's
// columns — enough to count unread and render a row.
export type NotificationRow = {
  id: string;
  kind: NotificationKind;
  read_at: string | null;
};

// Unread = no read_at. The badge shows this count; the feed uses it to decide
// whether "Mark all read" does anything.
export function unreadCount(rows: Pick<NotificationRow, "read_at">[]): number {
  return rows.reduce((n, r) => (r.read_at == null ? n + 1 : n), 0);
}

// The ids "Mark all read" must flip — only the still-unread ones, so we don't
// issue a no-op UPDATE that touches already-read rows (and re-stamps nothing).
export function unreadIds(rows: NotificationRow[]): string[] {
  return rows.filter((r) => r.read_at == null).map((r) => r.id);
}
