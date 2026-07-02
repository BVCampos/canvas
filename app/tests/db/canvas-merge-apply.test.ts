// ============================================================
// canvas_apply_merged_edit — rebased-proposal apply, in real SQL (migration 0050)
// ============================================================
// When a stale slide_edit is approved, the app 3-way-merges it onto current and
// commits the merged content through this RPC. It mirrors canvas_apply_edit's
// slide_edit branch (append immutable version, sync denorm, flip status) plus:
//   • the same self-approval guard, and
//   • an optimistic base-moved check: refuse if the slide advanced past the
//     version the merge was computed against.
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

async function readSlide(slideId: string) {
  const { rows } = await db.query<{
    html_body: string;
    slide_styles: string;
    title: string;
    current_version_id: string;
  }>(
    "select html_body, slide_styles, title, current_version_id from public.canvas_deck_slide where id = $1",
    [slideId],
  );
  return rows[0];
}
async function versionCount(slideId: string) {
  const { rows } = await db.query<{ n: string }>(
    "select count(*)::text as n from public.canvas_slide_version where slide_id = $1",
    [slideId],
  );
  return Number(rows[0].n);
}
async function editStatus(editId: string) {
  const { rows } = await db.query<{ status: string; resolved_by: string | null }>(
    "select status, resolved_by from public.canvas_deck_edit where id = $1",
    [editId],
  );
  return rows[0];
}

// Seed a workspace with an owner + a member, a deck, a slide at v1, then advance
// the slide to v2 (so a proposal built from v1 is stale). Returns the ids needed.
async function seedStale() {
  const ws = await makeWorkspace(db);
  const owner = await makeUser(db);
  const member = await makeUser(db);
  await addMembership(db, ws, owner, "owner");
  await addMembership(db, ws, member, "member");
  const deck = await makeDeck(db, { workspaceId: ws, createdBy: owner, visibility: "workspace" });
  const { slideId, versionId: v1 } = await makeSlide(db, {
    workspaceId: ws,
    deckId: deck,
    position: 0,
    createdBy: owner,
    htmlBody: "base",
  });
  // Advance to v2 via a normal owner edit (owner may self-approve).
  const advance = await makePendingSlideEdit(db, {
    workspaceId: ws,
    deckId: deck,
    slideId,
    kind: "slide_edit",
    proposedBy: owner,
    payload: { html_body: "current" },
    baseVersionId: v1,
  });
  await asUser(db, owner);
  await db.query("select public.canvas_apply_edit($1)", [advance]);
  const v2 = (await readSlide(slideId)).current_version_id;
  // The stale proposal: a member built it from v1 (theirs).
  const stale = await makePendingSlideEdit(db, {
    workspaceId: ws,
    deckId: deck,
    slideId,
    kind: "slide_edit",
    proposedBy: member,
    payload: { html_body: "theirs", title: "Merged Title" },
    baseVersionId: v1,
  });
  return { ws, owner, member, deck, slideId, v1, v2, stale };
}

describe("canvas_apply_merged_edit", () => {
  it("commits merged content as a new version, syncs denorm, flips status", async () => {
    const { owner, slideId, v2, stale } = await seedStale();
    await asUser(db, owner); // approver != proposer
    await db.query(
      "select public.canvas_apply_merged_edit($1, $2, $3, $4)",
      [stale, "MERGED-HTML", "MERGED-CSS", v2],
    );
    const slide = await readSlide(slideId);
    expect(slide.html_body).toBe("MERGED-HTML");
    expect(slide.slide_styles).toBe("MERGED-CSS");
    expect(slide.title).toBe("Merged Title"); // from the proposal payload
    expect(await versionCount(slideId)).toBe(3); // v1, v2, merged v3
    // The new version parents off v2 (current), not v1 (the proposal's base).
    const { rows } = await db.query<{ parent_version_id: string }>(
      "select parent_version_id from public.canvas_slide_version where id = $1",
      [slide.current_version_id],
    );
    expect(rows[0].parent_version_id).toBe(v2);
    const e = await editStatus(stale);
    expect(e.status).toBe("applied");
    expect(e.resolved_by).toBe(owner);
  });

  it("refuses when the slide advanced past the version the merge was computed on", async () => {
    const { owner, v1, stale } = await seedStale();
    await asUser(db, owner);
    // Pass v1 as the expected-current, but current is actually v2 -> base moved.
    await expect(
      db.query("select public.canvas_apply_merged_edit($1, $2, $3, $4)", [stale, "X", "", v1]),
    ).rejects.toThrow(/merge_base_moved/);
  });

  it("refuses a proposal whose recorded base is not a version of this slide (merge_base_invalid)", async () => {
    // 0052 defense-in-depth: a sound merge's base must be a version of THIS slide
    // at or before current. Build a proposal on slide A whose base_version_id
    // points at a DIFFERENT slide's version — a mismatched (base, current) pair
    // the app never produces. A's current is unchanged, so merge_base_moved
    // passes and the base-lineage guard is what must reject it.
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    const deck = await makeDeck(db, { workspaceId: ws, createdBy: owner, visibility: "workspace" });
    const a = await makeSlide(db, { workspaceId: ws, deckId: deck, position: 0, createdBy: owner, htmlBody: "A" });
    const b = await makeSlide(db, { workspaceId: ws, deckId: deck, position: 1, createdBy: owner, htmlBody: "B" });
    const bad = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId: deck,
      slideId: a.slideId,
      kind: "slide_edit",
      proposedBy: owner, // owner self-approves (admin) so the guard under test is the one that fires
      payload: { html_body: "theirs" },
      baseVersionId: b.versionId,
    });
    await asUser(db, owner);
    await expect(
      db.query("select public.canvas_apply_merged_edit($1, $2, $3, $4)", [bad, "X", "", a.versionId]),
    ).rejects.toThrow(/merge_base_invalid/);
  });

  it("enforces the self-approval guard (proposer can't merge-approve their own)", async () => {
    const { member, v2, stale } = await seedStale();
    await asUser(db, member); // the proposer
    await expect(
      db.query("select public.canvas_apply_merged_edit($1, $2, $3, $4)", [stale, "X", "", v2]),
    ).rejects.toThrow(/own proposal/);
  });

  it("refuses a non-pending edit (double-apply)", async () => {
    const { owner, v2, slideId, stale } = await seedStale();
    await asUser(db, owner);
    await db.query("select public.canvas_apply_merged_edit($1, $2, $3, $4)", [stale, "M", "", v2]);
    const v3 = (await readSlide(slideId)).current_version_id;
    // Second attempt: edit is now 'applied', and the base also moved to v3.
    await expect(
      db.query("select public.canvas_apply_merged_edit($1, $2, $3, $4)", [stale, "M2", "", v3]),
    ).rejects.toThrow(/not pending/);
  });
});
