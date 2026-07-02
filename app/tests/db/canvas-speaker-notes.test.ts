// ============================================================
// canvas_save_slide_notes_direct (migration 0067) — in real SQL.
// ============================================================
// A DIRECT write (no proposal — ADR-0012 litmus), so the explicit
// canvas_can_edit_deck gate is the ONLY authorization; these pin it plus
// the trim/clear semantics.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  freshDb,
  asUser,
  makeUser,
  makeWorkspace,
  addMembership,
  makeDeck,
  makeSlide,
  type Pg,
} from "./setup";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

async function fixture() {
  const owner = await makeUser(db, "owner@n.test");
  const ws = await makeWorkspace(db);
  await addMembership(db, ws, owner, "owner");
  const deck = await makeDeck(db, { workspaceId: ws, createdBy: owner });
  const { slideId } = await makeSlide(db, {
    workspaceId: ws,
    deckId: deck,
    position: 0,
    createdBy: owner,
  });
  return { owner, ws, deck, slideId };
}

async function notesOf(slideId: string): Promise<string | null> {
  const { rows } = await db.query<{ speaker_notes: string | null }>(
    "select speaker_notes from public.canvas_deck_slide where id = $1",
    [slideId],
  );
  return rows[0].speaker_notes;
}

describe("canvas_save_slide_notes_direct", () => {
  it("saves trimmed notes for a deck editor, without minting a version", async () => {
    const { owner, slideId } = await fixture();
    const before = await db.query<{ n: string }>(
      "select count(*)::text as n from public.canvas_slide_version where slide_id = $1",
      [slideId],
    );
    await asUser(db, owner);
    await db.query("select public.canvas_save_slide_notes_direct($1, $2)", [
      slideId,
      "  Open with the Q2 numbers.  ",
    ]);
    expect(await notesOf(slideId)).toBe("Open with the Q2 numbers.");
    const after = await db.query<{ n: string }>(
      "select count(*)::text as n from public.canvas_slide_version where slide_id = $1",
      [slideId],
    );
    // Notes are NOT versioned — the history is untouched.
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("clears notes on empty/whitespace input", async () => {
    const { owner, slideId } = await fixture();
    await asUser(db, owner);
    await db.query("select public.canvas_save_slide_notes_direct($1, $2)", [
      slideId,
      "something",
    ]);
    await db.query("select public.canvas_save_slide_notes_direct($1, $2)", [
      slideId,
      "   ",
    ]);
    expect(await notesOf(slideId)).toBeNull();
  });

  it("blocks a caller without deck edit rights", async () => {
    const { ws, slideId } = await fixture();
    const guest = await makeUser(db, "guest@n.test");
    await addMembership(db, ws, guest, "guest");
    await asUser(db, guest);
    await expect(
      db.query("select public.canvas_save_slide_notes_direct($1, $2)", [
        slideId,
        "sneaky",
      ]),
    ).rejects.toThrow(/not_authorized/);
    expect(await notesOf(slideId)).toBeNull();
  });

  it("rejects an unauthenticated caller", async () => {
    const { slideId } = await fixture();
    await asUser(db, null);
    await expect(
      db.query("select public.canvas_save_slide_notes_direct($1, $2)", [
        slideId,
        "x",
      ]),
    ).rejects.toThrow(/not authenticated/);
  });
});
