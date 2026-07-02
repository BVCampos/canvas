// ============================================================
// Migration 0053 — assistant turn cancellation, in real SQL.
// ============================================================
// Stop (ADR-0008) needs two schema changes on canvas_assistant_message:
//   • a nullable cancel_requested_at column (the Stop server action sets it on
//     the in-flight prompt row; the bridge polls it via cancel-check), and
//   • a widened status CHECK that admits the new terminal 'canceled'.
// This boots the real migration list in pglite and proves the live table
// accepts both — the column is writable, 'canceled' is a legal status, and an
// off-list status is still rejected (the CHECK didn't get loosened to anything).
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  freshDb,
  makeWorkspaceWithOwner,
  makeDeck,
  type Pg,
} from "./setup";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

// Seed a thread + one prompt row (role='user', status='running') directly, as a
// service-role/seed path would. Returns the message id.
async function seedRunningPrompt(): Promise<{
  workspaceId: string;
  deckId: string;
  userId: string;
  messageId: string;
}> {
  const { workspaceId, ownerId } = await makeWorkspaceWithOwner(db);
  const deckId = await makeDeck(db, { workspaceId, createdBy: ownerId });
  const threadId = randomUUID();
  await db.query(
    `insert into public.canvas_assistant_thread (id, deck_id, workspace_id, user_id, title)
     values ($1, $2, $3, $4, $5)`,
    [threadId, deckId, workspaceId, ownerId, "stop me"],
  );
  const messageId = randomUUID();
  await db.query(
    `insert into public.canvas_assistant_message
       (id, deck_id, workspace_id, user_id, thread_id, role, content, status)
     values ($1, $2, $3, $4, $5, 'user', $6, 'running')`,
    [messageId, deckId, workspaceId, ownerId, threadId, "do a thing"],
  );
  return { workspaceId, deckId, userId: ownerId, messageId };
}

describe("migration 0053: assistant cancel", () => {
  it("cancel_requested_at column exists and is writable", async () => {
    const { messageId } = await seedRunningPrompt();

    const ts = new Date().toISOString();
    await db.query(
      "update public.canvas_assistant_message set cancel_requested_at = $1 where id = $2",
      [ts, messageId],
    );

    const { rows } = await db.query<{ cancel_requested_at: string | null }>(
      "select cancel_requested_at from public.canvas_assistant_message where id = $1",
      [messageId],
    );
    expect(rows[0].cancel_requested_at).not.toBeNull();
  });

  it("status CHECK admits the new terminal 'canceled'", async () => {
    const { messageId } = await seedRunningPrompt();

    await expect(
      db.query(
        "update public.canvas_assistant_message set status = 'canceled' where id = $1",
        [messageId],
      ),
    ).resolves.toBeDefined();

    const { rows } = await db.query<{ status: string }>(
      "select status from public.canvas_assistant_message where id = $1",
      [messageId],
    );
    expect(rows[0].status).toBe("canceled");
  });

  it("status CHECK still rejects an off-list value (constraint wasn't loosened)", async () => {
    const { messageId } = await seedRunningPrompt();

    await expect(
      db.query(
        "update public.canvas_assistant_message set status = 'banana' where id = $1",
        [messageId],
      ),
    ).rejects.toThrow();
  });
});
