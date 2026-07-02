// ============================================================
// canvas_restore_slide_version / canvas_restore_snapshot — forward-only.
// ============================================================
// The versioning contract (CONTEXT.md + migration 0002 header) is that a
// restore is NEVER destructive: it appends a NEW version that COPIES the target
// content, leaving every prior version row byte-for-byte intact. History stays
// linear forever. These tests pin that — a restore must not mutate the row it
// restores from, and the denorm cache must follow the new head.
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
  makePendingSlideEdit,
  type Pg,
} from "./setup";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

async function versions(slideId: string) {
  const { rows } = await db.query<{
    id: string;
    version_no: number;
    html_body: string;
    source_prompt: string | null;
  }>(
    `select id, version_no, html_body, source_prompt
       from public.canvas_slide_version where slide_id = $1 order by version_no asc`,
    [slideId],
  );
  return rows;
}

async function readSlide(slideId: string) {
  const { rows } = await db.query<{ html_body: string; current_version_id: string }>(
    "select html_body, current_version_id from public.canvas_deck_slide where id = $1",
    [slideId],
  );
  return rows[0];
}

/** Build a slide with three versions: v1 (seed), v2, v3 (via apply_edit). */
async function slideWithThreeVersions() {
  const ws = await makeWorkspace(db);
  const proposer = await makeUser(db);
  const reviewer = await makeUser(db);
  await addMembership(db, ws, proposer, "member");
  await addMembership(db, ws, reviewer, "member");
  const deckId = await makeDeck(db, { workspaceId: ws, createdBy: proposer });
  const { slideId, versionId: v1 } = await makeSlide(db, {
    workspaceId: ws,
    deckId,
    position: 0,
    createdBy: proposer,
    htmlBody: "<section>v1</section>",
  });

  const e1 = await makePendingSlideEdit(db, {
    workspaceId: ws,
    deckId,
    slideId,
    kind: "slide_html",
    proposedBy: proposer,
    newContent: "<section>v2</section>",
    baseVersionId: v1,
  });
  await asUser(db, reviewer);
  await db.query("select public.canvas_apply_edit($1)", [e1]);
  const v2 = (await readSlide(slideId)).current_version_id;

  const e2 = await makePendingSlideEdit(db, {
    workspaceId: ws,
    deckId,
    slideId,
    kind: "slide_html",
    proposedBy: proposer,
    newContent: "<section>v3</section>",
    baseVersionId: v2,
  });
  await asUser(db, reviewer);
  await db.query("select public.canvas_apply_edit($1)", [e2]);

  return { ws, reviewer, deckId, slideId, v1, v2 };
}

describe("canvas_restore_slide_version: forward-only", () => {
  it("restores by APPENDING a copy, never mutating the restored-from version", async () => {
    const { reviewer, slideId, v1 } = await slideWithThreeVersions();

    const before = await versions(slideId);
    expect(before.map((v) => v.html_body)).toEqual([
      "<section>v1</section>",
      "<section>v2</section>",
      "<section>v3</section>",
    ]);

    // Restore back to v1.
    await asUser(db, reviewer);
    await db.query("select public.canvas_restore_slide_version($1, $2)", [slideId, v1]);

    const after = await versions(slideId);
    // A NEW v4 was appended; the three originals are byte-identical.
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3).map((v) => v.html_body)).toEqual([
      "<section>v1</section>",
      "<section>v2</section>",
      "<section>v3</section>",
    ]);
    // v4 copies v1's content and is labelled as a restore.
    expect(after[3].version_no).toBe(4);
    expect(after[3].html_body).toBe("<section>v1</section>");
    expect(after[3].source_prompt).toMatch(/restored from v1/);

    // denorm cache points at the new head, showing v1's content.
    const slide = await readSlide(slideId);
    expect(slide.html_body).toBe("<section>v1</section>");
    expect(slide.current_version_id).toBe(after[3].id);
  });

  it("refuses a source version that belongs to a different slide", async () => {
    const { ws, reviewer, deckId, slideId } = await slideWithThreeVersions();
    // A second slide with its own v1 in the same deck.
    const other = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 1,
      createdBy: reviewer,
    });

    await asUser(db, reviewer);
    await expect(
      db.query("select public.canvas_restore_slide_version($1, $2)", [
        slideId,
        other.versionId,
      ]),
    ).rejects.toThrow(/different slide/);
    // No new version appended on the target.
    expect(await versions(slideId)).toHaveLength(3);
  });
});

describe("canvas_restore_snapshot: forward-only", () => {
  it("restores a snapshot by appending new versions, leaving history intact", async () => {
    const { ws, reviewer, deckId, slideId, v1 } = await slideWithThreeVersions();

    // Capture a snapshot pinned to v1 (the slide is currently at v3).
    await asUser(db, reviewer);
    const { rows: snapRows } = await db.query<{ id: string }>(
      `insert into public.canvas_deck_snapshot (workspace_id, deck_id, label, created_by)
       values ($1, $2, 'pin at v1', $3) returning id`,
      [ws, deckId, reviewer],
    );
    const snapshotId = snapRows[0].id;
    await db.query(
      `insert into public.canvas_deck_snapshot_slide (snapshot_id, slide_version_id, position)
       values ($1, $2, 0)`,
      [snapshotId, v1],
    );

    const beforeCount = (await versions(slideId)).length;
    expect(beforeCount).toBe(3);

    await asUser(db, reviewer);
    const { rows } = await db.query<{ canvas_restore_snapshot: number }>(
      "select public.canvas_restore_snapshot($1)",
      [snapshotId],
    );
    // One slide restored.
    expect(rows[0].canvas_restore_snapshot).toBe(1);

    const after = await versions(slideId);
    // Originals intact, one appended copy of v1.
    expect(after.length).toBe(4);
    expect(after.slice(0, 3).map((v) => v.html_body)).toEqual([
      "<section>v1</section>",
      "<section>v2</section>",
      "<section>v3</section>",
    ]);
    expect(after[3].html_body).toBe("<section>v1</section>");
    expect((await readSlide(slideId)).html_body).toBe("<section>v1</section>");

    // restore_snapshot also writes a pre_restore safety snapshot first.
    const { rows: kinds } = await db.query<{ kind: string }>(
      "select kind from public.canvas_deck_snapshot where deck_id = $1 order by created_at",
      [deckId],
    );
    expect(kinds.some((k) => k.kind === "pre_restore")).toBe(true);
  });
});

// ============================================================
// canvas_restore_snapshot: reconstructs a slide deleted since the snapshot.
// ============================================================
// Regression for the data-loss bug fixed in migration 0061. A snapshot taken
// while a slide existed must bring that slide back even after it was hard-
// deleted — which used to be impossible because (a) restore skipped missing
// slides and (b) the delete cascade hollowed the snapshot's pointer out. The
// snapshot is now self-contained (denormalized content + ON DELETE SET NULL),
// and restore re-inserts the missing slide at its captured position.
// ============================================================
describe("canvas_restore_snapshot: reconstructs deleted slides", () => {
  async function slideRows(deckId: string) {
    const { rows } = await db.query<{
      id: string;
      position: number;
      html_body: string;
    }>(
      "select id, position, html_body from public.canvas_deck_slide where deck_id = $1 order by position asc",
      [deckId],
    );
    return rows;
  }

  it("brings back a middle slide deleted after the snapshot, at its position", async () => {
    const ws = await makeWorkspace(db);
    const proposer = await makeUser(db);
    const reviewer = await makeUser(db);
    await addMembership(db, ws, proposer, "member");
    await addMembership(db, ws, reviewer, "member");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: proposer });

    const a = await makeSlide(db, {
      workspaceId: ws, deckId, position: 0, createdBy: proposer,
      htmlBody: "<section>A</section>",
    });
    const b = await makeSlide(db, {
      workspaceId: ws, deckId, position: 1, createdBy: proposer,
      htmlBody: "<section>B</section>",
    });
    const c = await makeSlide(db, {
      workspaceId: ws, deckId, position: 2, createdBy: proposer,
      htmlBody: "<section>C</section>",
    });

    // Capture a snapshot of all three slides via the RPC (so the denormalized
    // content is written exactly as production captures it).
    await asUser(db, reviewer);
    const { rows: snapRows } = await db.query<{ id: string }>(
      "select (public.canvas_create_snapshot($1, $2)).id as id",
      [deckId, "before delete"],
    );
    const snapshotId = snapRows[0].id;

    // Delete the MIDDLE slide (B) through the real propose -> approve delete path.
    const del = await makePendingSlideEdit(db, {
      workspaceId: ws, deckId, slideId: b.slideId, kind: "slide_delete",
      proposedBy: proposer,
    });
    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [del]);

    // Deck is now [A, C]; B and all its versions are hard-gone.
    expect((await slideRows(deckId)).map((s) => s.html_body)).toEqual([
      "<section>A</section>",
      "<section>C</section>",
    ]);
    const { rows: bGone } = await db.query(
      "select 1 from public.canvas_deck_slide where id = $1",
      [b.slideId],
    );
    expect(bGone).toHaveLength(0);

    // The snapshot row for B SURVIVED the delete cascade (pointer NULLed, content
    // preserved) — the heart of the fix.
    const { rows: keptB } = await db.query<{
      slide_version_id: string | null;
      html_body: string;
    }>(
      "select slide_version_id, html_body from public.canvas_deck_snapshot_slide where snapshot_id = $1 and slide_id = $2",
      [snapshotId, b.slideId],
    );
    expect(keptB).toHaveLength(1);
    expect(keptB[0].slide_version_id).toBeNull();
    expect(keptB[0].html_body).toBe("<section>B</section>");

    // Restore: all three slides are touched (A + C re-versioned, B reconstructed).
    await asUser(db, reviewer);
    const { rows: restored } = await db.query<{ canvas_restore_snapshot: number }>(
      "select public.canvas_restore_snapshot($1)",
      [snapshotId],
    );
    expect(restored[0].canvas_restore_snapshot).toBe(3);

    // Deck is [A, B, C] again, in order, with B's content recovered.
    const after = await slideRows(deckId);
    expect(after.map((s) => s.html_body)).toEqual([
      "<section>A</section>",
      "<section>B</section>",
      "<section>C</section>",
    ]);
    // Reconstruction reused the original slide id and gave it a fresh v1.
    const rebuilt = after.find((s) => s.html_body === "<section>B</section>")!;
    expect(rebuilt.id).toBe(b.slideId);
    expect(rebuilt.position).toBe(1);
    const { rows: bVersions } = await db.query<{ version_no: number }>(
      "select version_no from public.canvas_slide_version where slide_id = $1 order by version_no",
      [b.slideId],
    );
    expect(bVersions.map((v) => v.version_no)).toEqual([1]);

    // A and C kept their identity (forward-only re-version, not reconstruction).
    expect(after.find((s) => s.html_body === "<section>A</section>")!.id).toBe(a.slideId);
    expect(after.find((s) => s.html_body === "<section>C</section>")!.id).toBe(c.slideId);
  });
});
