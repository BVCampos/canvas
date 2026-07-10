// DB-level tests for migration 0075 — the fast-lane choice follows the user.
//
// canvas_deck_inherit_fast_lane is a BEFORE INSERT trigger, so its behavior is
// DB-only and must be pinned here against the real migration: a wrong trigger
// silently seeds (or fails to seed) a security-relevant flag on every deck any
// creation path inserts. The pref row is seeded as superuser, mirroring how
// the app writes it (the setDeckAgentFastLane action under the user's RLS).

import { beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  freshDb,
  makeDeck,
  makeUser,
  makeWorkspace,
  type Pg,
} from "./setup";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

async function setDefault(userId: string, enabled: boolean): Promise<void> {
  await db.query(
    `insert into public.canvas_user_fast_lane_default (user_id, enabled)
     values ($1, $2)
     on conflict (user_id) do update set enabled = excluded.enabled`,
    [userId, enabled],
  );
}

async function deckFlag(deckId: string): Promise<boolean> {
  const { rows } = await db.query<{ agent_fast_lane_enabled: boolean }>(
    "select agent_fast_lane_enabled from public.canvas_deck where id = $1",
    [deckId],
  );
  return rows[0].agent_fast_lane_enabled;
}

async function fixture() {
  const workspaceId = await makeWorkspace(db);
  const userId = await makeUser(db);
  await addMembership(db, workspaceId, userId, "member");
  return { workspaceId, userId };
}

describe("canvas_deck_inherit_fast_lane (0075)", () => {
  it("leaves a new deck off when the creator has no stored preference", async () => {
    const { workspaceId, userId } = await fixture();
    const deckId = await makeDeck(db, { workspaceId, createdBy: userId });
    expect(await deckFlag(deckId)).toBe(false);
  });

  it("a stored `enabled` preference turns the lane on for decks the user creates", async () => {
    const { workspaceId, userId } = await fixture();
    await setDefault(userId, true);
    const deckId = await makeDeck(db, { workspaceId, createdBy: userId });
    expect(await deckFlag(deckId)).toBe(true);
  });

  it("a stored `disabled` preference leaves new decks off", async () => {
    const { workspaceId, userId } = await fixture();
    await setDefault(userId, false);
    const deckId = await makeDeck(db, { workspaceId, createdBy: userId });
    expect(await deckFlag(deckId)).toBe(false);
  });

  it("keeps a caller's explicit true even when the stored preference is disabled", async () => {
    const { workspaceId, userId } = await fixture();
    await setDefault(userId, false);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.canvas_deck (workspace_id, title, created_by, agent_fast_lane_enabled)
       values ($1, 'Explicitly opted in', $2, true)
       returning id`,
      [workspaceId, userId],
    );
    expect(await deckFlag(rows[0].id)).toBe(true);
  });

  it("inherits from the CREATOR's preference, not some other user's", async () => {
    const { workspaceId, userId } = await fixture();
    const otherId = await makeUser(db);
    await addMembership(db, workspaceId, otherId, "member");
    await setDefault(otherId, true);
    const deckId = await makeDeck(db, { workspaceId, createdBy: userId });
    expect(await deckFlag(deckId)).toBe(false);
  });

  it("the last choice wins: re-upserting the preference changes only FUTURE decks", async () => {
    const { workspaceId, userId } = await fixture();
    await setDefault(userId, true);
    const first = await makeDeck(db, { workspaceId, createdBy: userId });
    await setDefault(userId, false);
    const second = await makeDeck(db, { workspaceId, createdBy: userId });
    expect(await deckFlag(first)).toBe(true);
    expect(await deckFlag(second)).toBe(false);
  });
});
