// ============================================================
// canvas_duplicate_slide_direct + canvas_delete_slide_direct — the DIRECT
// (non-proposal) duplicate/delete ops, in real SQL (migration 0071).
// ============================================================
// These finish ADR-0012: duplicate (purely additive) and delete (recoverable
// via snapshots, audited by the 0037 activity trigger) go direct for deck
// editors, mirroring 0061's create/reorder. Both are SECURITY DEFINER, so the
// assertions pin:
//   • the EXPLICIT canvas_can_edit_deck gate blocks a non-editor and a viewer
//     (the DEFINER body bypasses RLS, so this check is the ONLY authorization);
//   • positions stay 0-based contiguous (shift-right on duplicate, compact-left
//     on delete);
//   • delete keeps canvas_apply_edit's guards (only-slide refusal) and still
//     writes the canvas_deck_activity audit row.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  freshDb,
  asUser,
  callBoolHelper,
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

async function slidesByPosition(deckId: string) {
  const { rows } = await db.query<{
    id: string;
    position: number;
    title: string;
    html_body: string;
    slide_styles: string | null;
    speaker_notes: string | null;
    owner_id: string | null;
    created_by: string | null;
    current_version_id: string | null;
  }>(
    `select id, position, title, html_body, slide_styles, speaker_notes,
            owner_id, created_by, current_version_id
       from public.canvas_deck_slide where deck_id = $1 order by position asc`,
    [deckId],
  );
  return rows;
}

async function deckWithSlides(
  ws: string,
  owner: string,
  n: number,
): Promise<{ deckId: string; slideIds: string[] }> {
  const deckId = await makeDeck(db, { workspaceId: ws, createdBy: owner });
  const slideIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const { slideId } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: i,
      createdBy: owner,
      title: `s${i}`,
      htmlBody: `<section class="slide">s${i}</section>`,
    });
    slideIds.push(slideId);
  }
  return { deckId, slideIds };
}

describe("canvas_duplicate_slide_direct", () => {
  it("copies content verbatim and inserts the copy right after the source", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3); // s0 s1 s2

    await asUser(db, editor);
    const { rows } = await db.query<{
      id: string;
      position: number;
      title: string;
      html_body: string;
      owner_id: string | null;
      created_by: string | null;
      current_version_id: string | null;
    }>(`select * from public.canvas_duplicate_slide_direct($1)`, [slideIds[1]]);

    expect(rows[0].position).toBe(2);
    expect(rows[0].title).toBe("s1");
    expect(rows[0].html_body).toBe('<section class="slide">s1</section>');
    // Unowned so any deck editor can immediately work the copy; attributed.
    expect(rows[0].owner_id).toBeNull();
    expect(rows[0].created_by).toBe(editor);
    // The init-version trigger versioned the copy (re-read contract).
    expect(rows[0].current_version_id).not.toBeNull();

    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    expect(slides.map((s) => s.title)).toEqual(["s0", "s1", "s1", "s2"]);
  });

  it("does NOT copy speaker notes (same contract as the propose/copy tools)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 1);
    await db.query(
      `update public.canvas_deck_slide set speaker_notes = 'talk track' where id = $1`,
      [slideIds[0]],
    );

    await asUser(db, editor);
    await db.query(`select public.canvas_duplicate_slide_direct($1)`, [slideIds[0]]);

    const slides = await slidesByPosition(deckId);
    expect(slides[0].speaker_notes).toBe("talk track");
    expect(slides[1].speaker_notes).toBeNull();
  });

  it("duplicating the last slide appends (no shift needed)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2); // s0 s1

    await asUser(db, editor);
    const { rows } = await db.query<{ position: number }>(
      `select position from public.canvas_duplicate_slide_direct($1)`,
      [slideIds[1]],
    );
    expect(rows[0].position).toBe(2);
    expect((await slidesByPosition(deckId)).map((s) => s.title)).toEqual([
      "s0",
      "s1",
      "s1",
    ]);
  });

  it("rejects a non-editor and a read-only deck viewer (edit gate, not read)", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    await addMembership(db, ws, owner, "member");
    const viewer = await makeUser(db);
    await addMembership(db, ws, viewer, "member");
    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
    });
    const { slideId } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: owner,
      title: "s0",
    });
    await db.query(
      `insert into public.canvas_deck_member (deck_id, user_id, workspace_id, role)
       values ($1, $2, $3, 'viewer')`,
      [deckId, viewer, ws],
    );
    expect(await callBoolHelper(db, viewer, "canvas_can_read_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, viewer, "canvas_can_edit_deck", deckId)).toBe(false);

    await asUser(db, viewer);
    await expect(
      db.query(`select public.canvas_duplicate_slide_direct($1)`, [slideId]),
    ).rejects.toThrow(/not_authorized/);

    const stranger = await makeUser(db);
    await asUser(db, stranger);
    await expect(
      db.query(`select public.canvas_duplicate_slide_direct($1)`, [slideId]),
    ).rejects.toThrow(/not_authorized/);

    expect(await slidesByPosition(deckId)).toHaveLength(1);
  });

  it("rejects an anonymous caller", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { slideIds } = await deckWithSlides(ws, editor, 1);

    await asUser(db, null);
    await expect(
      db.query(`select public.canvas_duplicate_slide_direct($1)`, [slideIds[0]]),
    ).rejects.toThrow(/not authenticated/);
  });

  it("writes a slide_duplicate activity row naming the source slide (0073 audit)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3); // s0 s1 s2

    await asUser(db, editor);
    const { rows: created } = await db.query<{ id: string }>(
      `select id from public.canvas_duplicate_slide_direct($1)`,
      [slideIds[1]],
    );

    // Read detail via ->> so the assertion is agnostic to jsonb parsing.
    const { rows } = await db.query<{
      action: string;
      actor_id: string | null;
      actor_kind: string;
      slide_id: string | null;
      slide_title: string | null;
      source_slide_id: string | null;
      source_slide_title: string | null;
    }>(
      `select action, actor_id, actor_kind, slide_id,
              detail->>'slide_title'        as slide_title,
              detail->>'source_slide_id'    as source_slide_id,
              detail->>'source_slide_title' as source_slide_title
         from public.canvas_deck_activity where deck_id = $1`,
      [deckId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("slide_duplicate");
    // Credited to the caller (auth.uid()), not the deck owner.
    expect(rows[0].actor_id).toBe(editor);
    expect(rows[0].actor_kind).toBe("user");
    // The audit row points at the NEW copy and carries the SOURCE slide.
    expect(rows[0].slide_id).toBe(created[0].id);
    expect(rows[0].slide_title).toBe("s1");
    expect(rows[0].source_slide_id).toBe(slideIds[1]);
    expect(rows[0].source_slide_title).toBe("s1");
  });
});

describe("canvas_delete_slide_direct", () => {
  it("deletes the slide and compacts later positions left", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3); // s0 s1 s2

    await asUser(db, editor);
    const { rows } = await db.query<{ pos: number }>(
      `select public.canvas_delete_slide_direct($1) as pos`,
      [slideIds[1]],
    );
    expect(rows[0].pos).toBe(1);

    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.title)).toEqual(["s0", "s2"]);
    expect(slides.map((s) => s.position)).toEqual([0, 1]);
  });

  it("refuses to delete the deck's only slide (canvas_apply_edit parity)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { slideIds } = await deckWithSlides(ws, editor, 1);

    await asUser(db, editor);
    await expect(
      db.query(`select public.canvas_delete_slide_direct($1)`, [slideIds[0]]),
    ).rejects.toThrow(/only slide/);
  });

  it("writes the canvas_deck_activity audit row (the 0037 trigger fires on this path too)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2);

    await asUser(db, editor);
    await db.query(`select public.canvas_delete_slide_direct($1)`, [slideIds[0]]);

    const { rows } = await db.query<{
      action: string;
      actor_id: string | null;
      deck_id: string;
    }>(
      `select action, actor_id, deck_id from public.canvas_deck_activity where deck_id = $1`,
      [deckId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("slide_delete");
    expect(rows[0].actor_id).toBe(editor);
  });

  it("rejects a non-editor and leaves the deck intact", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2);

    const stranger = await makeUser(db);
    await asUser(db, stranger);
    await expect(
      db.query(`select public.canvas_delete_slide_direct($1)`, [slideIds[0]]),
    ).rejects.toThrow(/not_authorized/);
    expect(await slidesByPosition(deckId)).toHaveLength(2);
  });

  it("rejects an anonymous caller", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { slideIds } = await deckWithSlides(ws, editor, 2);

    await asUser(db, null);
    await expect(
      db.query(`select public.canvas_delete_slide_direct($1)`, [slideIds[0]]),
    ).rejects.toThrow(/not authenticated/);
  });
});
