// ============================================================
// canvas_create_slide_direct + canvas_reorder_slides_direct — the DIRECT
// (non-proposal) structural slide ops, in real SQL (migration 0061).
// ============================================================
// These mirror canvas_apply_edit's slide_create / slide_reorder branches but
// skip the proposal: a deck editor's drag-to-reorder and "draw a new slide"
// apply immediately. Both are SECURITY DEFINER, so the assertions below pin the
// two things that matter most:
//   • the EXPLICIT canvas_can_edit_deck gate actually blocks a non-editor
//     (the DEFINER body bypasses RLS, so this check is the ONLY authorization);
//   • positions stay 0-based contiguous through the deferred-unique-constraint
//     shuffles (shift-right on create, full rewrite on reorder).
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

/** Slides for a deck, ordered by position, with the fields the assertions read. */
async function slidesByPosition(deckId: string) {
  const { rows } = await db.query<{
    id: string;
    position: number;
    title: string;
    html_body: string;
    owner_id: string | null;
    created_by: string | null;
    current_version_id: string | null;
  }>(
    `select id, position, title, html_body, owner_id, created_by, current_version_id
       from public.canvas_deck_slide where deck_id = $1 order by position asc`,
    [deckId],
  );
  return rows;
}

async function versionCount(slideId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from public.canvas_slide_version where slide_id = $1",
    [slideId],
  );
  return rows[0].n;
}

/** Build a deck with `n` slides at positions 0..n-1, titled s0, s1, …. */
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

describe("canvas_create_slide_direct", () => {
  it("appends a new versioned slide at the end (position == count)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 2);

    await asUser(db, editor);
    const { rows } = await db.query<{ id: string; position: number }>(
      `select id, position from public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, 2, "Drawn", '<section class="slide canvas-draw-slide">svg</section>', ""],
    );
    expect(rows[0].position).toBe(2);

    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(slides.map((s) => s.title)).toEqual(["s0", "s1", "Drawn"]);
    // The init-version trigger gave the new slide a v1.
    expect(await versionCount(rows[0].id)).toBe(1);
    expect(slides[2].current_version_id).not.toBeNull();
    // Unowned (any editor can later direct-edit), attributed to its creator.
    expect(slides[2].owner_id).toBeNull();
    expect(slides[2].created_by).toBe(editor);
  });

  it("inserts in the middle, shifting later slides right by one", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 3); // s0 s1 s2

    await asUser(db, editor);
    await db.query(
      `select public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, 1, "Mid", '<section class="slide">mid</section>', ""],
    );

    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    expect(slides.map((s) => s.title)).toEqual(["s0", "Mid", "s1", "s2"]);
  });

  it("clamps an out-of-range position to the end", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 2);

    await asUser(db, editor);
    const { rows } = await db.query<{ position: number }>(
      `select position from public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, 99, "End", '<section class="slide">end</section>', ""],
    );
    expect(rows[0].position).toBe(2);
    expect((await slidesByPosition(deckId)).map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("rejects a non-editor (the canvas_can_edit_deck gate)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 1);

    const stranger = await makeUser(db); // no membership → cannot edit
    await asUser(db, stranger);
    await expect(
      db.query(`select public.canvas_create_slide_direct($1, $2, $3, $4, $5)`, [
        deckId,
        1,
        "Nope",
        '<section class="slide">x</section>',
        "",
      ]),
    ).rejects.toThrow(/not_authorized/);
    // No slide leaked in.
    expect(await slidesByPosition(deckId)).toHaveLength(1);
  });

  it("rejects empty html", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 1);

    await asUser(db, editor);
    await expect(
      db.query(`select public.canvas_create_slide_direct($1, $2, $3, $4, $5)`, [
        deckId,
        1,
        "Empty",
        "   ",
        "",
      ]),
    ).rejects.toThrow(/html_body cannot be empty/);
  });

  it("writes a slide_create activity row crediting the drawer (0073 audit)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 2); // s0 s1

    await asUser(db, editor);
    const { rows: created } = await db.query<{ id: string; position: number }>(
      `select id, position from public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, 2, "Drawn", '<section class="slide canvas-draw-slide">svg</section>', ""],
    );

    // Read detail via ->> so the assertion is agnostic to jsonb parsing.
    const { rows } = await db.query<{
      action: string;
      actor_id: string | null;
      actor_kind: string;
      slide_id: string | null;
      slide_title: string | null;
      position: string | null;
    }>(
      `select action, actor_id, actor_kind, slide_id,
              detail->>'slide_title' as slide_title,
              detail->>'position'    as position
         from public.canvas_deck_activity where deck_id = $1`,
      [deckId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("slide_create");
    // Credited to the caller (auth.uid()).
    expect(rows[0].actor_id).toBe(editor);
    expect(rows[0].actor_kind).toBe("user");
    // Points at the created slide and carries its title + resting position.
    expect(rows[0].slide_id).toBe(created[0].id);
    expect(rows[0].slide_title).toBe("Drawn");
    expect(rows[0].position).toBe("2");
  });
});

describe("canvas_reorder_slides_direct", () => {
  it("rewrites positions to match the given order", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3); // s0 s1 s2

    // Move s2 to the front: [s2, s0, s1].
    const order = [slideIds[2], slideIds[0], slideIds[1]];
    await asUser(db, editor);
    const { rows } = await db.query<{ n: number }>(
      `select public.canvas_reorder_slides_direct($1, $2) as n`,
      [deckId, order],
    );
    expect(rows[0].n).toBe(3);

    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.title)).toEqual(["s2", "s0", "s1"]);
    expect(slides.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("swaps two adjacent slides (transient position collision survives deferral)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2); // s0 s1

    await asUser(db, editor);
    await db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [
      deckId,
      [slideIds[1], slideIds[0]],
    ]);
    expect((await slidesByPosition(deckId)).map((s) => s.title)).toEqual(["s1", "s0"]);
  });

  it("rejects an order of the wrong length", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3);

    await asUser(db, editor);
    await expect(
      db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [
        deckId,
        [slideIds[0], slideIds[1]], // missing one
      ]),
    ).rejects.toThrow(/exactly once/);
  });

  it("rejects duplicate ids in the order", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3);

    await asUser(db, editor);
    await expect(
      db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [
        deckId,
        [slideIds[0], slideIds[0], slideIds[1]],
      ]),
    ).rejects.toThrow(/duplicate/);
  });

  it("rejects an id that isn't in the deck", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2);
    // A slide from a DIFFERENT deck in the same workspace.
    const { deckId: otherDeck } = await deckWithSlides(ws, editor, 1);
    const foreign = (await slidesByPosition(otherDeck))[0].id;

    await asUser(db, editor);
    await expect(
      db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [
        deckId,
        [slideIds[0], foreign],
      ]),
    ).rejects.toThrow(/not in deck/);
  });

  it("rejects a non-editor (the canvas_can_edit_deck gate)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2);

    const stranger = await makeUser(db);
    await asUser(db, stranger);
    await expect(
      db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [
        deckId,
        [slideIds[1], slideIds[0]],
      ]),
    ).rejects.toThrow(/not_authorized/);
    // Order unchanged.
    expect((await slidesByPosition(deckId)).map((s) => s.title)).toEqual(["s0", "s1"]);
  });

  it("accepts the current order unchanged (drop-in-place no-op)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 3);

    await asUser(db, editor);
    const { rows } = await db.query<{ n: number }>(
      `select public.canvas_reorder_slides_direct($1, $2) as n`,
      [deckId, slideIds], // identity permutation
    );
    expect(rows[0].n).toBe(3);
    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(slides.map((s) => s.title)).toEqual(["s0", "s1", "s2"]);
  });
});

describe("canvas_create_slide_direct: boundaries + contract", () => {
  it("returns a row whose current_version_id is populated (the AFTER-INSERT trigger)", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 1);

    await asUser(db, editor);
    // Read current_version_id FROM the function's returned row (not a separate
    // query) — this is what guards the re-read-after-trigger contract.
    const { rows } = await db.query<{ current_version_id: string | null }>(
      `select current_version_id from public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, 1, "", '<section class="slide">x</section>', ""],
    );
    expect(rows[0].current_version_id).not.toBeNull();
  });

  it("creates the first slide of an empty (0-slide) deck at position 0", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: editor });

    await asUser(db, editor);
    const { rows } = await db.query<{ position: number; id: string }>(
      `select id, position from public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, null, "First", '<section class="slide">first</section>', ""],
    );
    expect(rows[0].position).toBe(0);
    expect(await versionCount(rows[0].id)).toBe(1);
  });

  it("clamps a negative position to 0 and shifts the rest right", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 2); // s0 s1

    await asUser(db, editor);
    await db.query(
      `select public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, -5, "Neg", '<section class="slide">neg</section>', ""],
    );
    const slides = await slidesByPosition(deckId);
    expect(slides.map((s) => s.title)).toEqual(["Neg", "s0", "s1"]);
    expect(slides.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("treats a null position as append", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId } = await deckWithSlides(ws, editor, 2);

    await asUser(db, editor);
    const { rows } = await db.query<{ position: number }>(
      `select position from public.canvas_create_slide_direct($1, $2, $3, $4, $5)`,
      [deckId, null, "End", '<section class="slide">end</section>', ""],
    );
    expect(rows[0].position).toBe(2);
  });
});

describe("direct structural ops: authorization edges", () => {
  it("rejects an anonymous (unauthenticated) caller on both RPCs", async () => {
    const ws = await makeWorkspace(db);
    const editor = await makeUser(db);
    await addMembership(db, ws, editor, "member");
    const { deckId, slideIds } = await deckWithSlides(ws, editor, 2);

    await asUser(db, null);
    await expect(
      db.query(`select public.canvas_create_slide_direct($1, $2, $3, $4, $5)`, [
        deckId,
        1,
        "x",
        '<section class="slide">x</section>',
        "",
      ]),
    ).rejects.toThrow(/not authenticated/);
    await expect(
      db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [
        deckId,
        [slideIds[1], slideIds[0]],
      ]),
    ).rejects.toThrow(/not authenticated/);
  });

  it("rejects a deck VIEWER on both RPCs — proving the gate is EDIT, not READ", async () => {
    // A non-member stranger can't read OR edit, so it can't tell the edit gate
    // from a read gate. A deck viewer can READ but not EDIT — the precise case
    // that pins these RPCs to canvas_can_edit_deck (not _read_deck).
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    await addMembership(db, ws, owner, "member");
    const viewer = await makeUser(db);
    await addMembership(db, ws, viewer, "member");
    // Private deck so the workspace-visible auto-edit branch can't apply.
    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
    });
    const { slideId: s0 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: owner,
      title: "s0",
    });
    const { slideId: s1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 1,
      createdBy: owner,
      title: "s1",
    });
    await db.query(
      `insert into public.canvas_deck_member (deck_id, user_id, workspace_id, role)
       values ($1, $2, $3, 'viewer')`,
      [deckId, viewer, ws],
    );
    // Sanity: read yes, edit no.
    expect(await callBoolHelper(db, viewer, "canvas_can_read_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, viewer, "canvas_can_edit_deck", deckId)).toBe(false);

    await asUser(db, viewer);
    await expect(
      db.query(`select public.canvas_create_slide_direct($1, $2, $3, $4, $5)`, [
        deckId,
        1,
        "nope",
        '<section class="slide">x</section>',
        "",
      ]),
    ).rejects.toThrow(/not_authorized/);
    await expect(
      db.query(`select public.canvas_reorder_slides_direct($1, $2)`, [deckId, [s1, s0]]),
    ).rejects.toThrow(/not_authorized/);
  });
});
