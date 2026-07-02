// ============================================================
// canvas_apply_edit — the propose→approve write path, in real SQL.
// ============================================================
// This RPC has been rewritten in full a dozen times and is where the worst
// prod incidents lived. The assertions below pin the contract the app and the
// MCP server rely on after an approve:
//   • a NEW immutable canvas_slide_version row is appended (history never
//     mutated), version_no incremented and monotonic;
//   • the canvas_deck_slide denorm cache (html_body / current_version_id) is
//     synced to that new version;
//   • the edit row flips to status='applied' with resolved_by/at stamped.
// Plus the self-approval guard (0034/0039/0040), which forces peer review of
// one's own content unless the workspace opted in, the proposer is an admin,
// or the edit reverts something the caller themselves resolved.
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

/** Read the denormalized slide cache row. */
async function readSlide(slideId: string) {
  const { rows } = await db.query<{
    html_body: string;
    title: string;
    slide_styles: string;
    current_version_id: string;
  }>(
    "select html_body, title, slide_styles, current_version_id from public.canvas_deck_slide where id = $1",
    [slideId],
  );
  return rows[0];
}

/** All versions for a slide, oldest first. */
async function versions(slideId: string) {
  const { rows } = await db.query<{
    id: string;
    version_no: number;
    html_body: string;
    parent_version_id: string | null;
    source_edit_id: string | null;
    author_kind: string;
  }>(
    `select id, version_no, html_body, parent_version_id, source_edit_id, author_kind
       from public.canvas_slide_version where slide_id = $1 order by version_no asc`,
    [slideId],
  );
  return rows;
}

async function readEdit(editId: string) {
  const { rows } = await db.query<{
    status: string;
    resolved_by: string | null;
    resolved_at: string | null;
  }>(
    "select status, resolved_by, resolved_at from public.canvas_deck_edit where id = $1",
    [editId],
  );
  return rows[0];
}

describe("canvas_apply_edit: slide_html apply", () => {
  it("appends an immutable version, syncs the denorm cache, and marks the edit applied", async () => {
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
      htmlBody: "<section>original</section>",
    });

    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: proposer,
      newContent: "<section>approved revision</section>",
      baseVersionId: v1,
      rationale: "tighten the copy",
    });

    // A DIFFERENT member approves (no self-approval question here).
    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [editId]);

    // 1. A new immutable version row exists; v1 untouched.
    const vrows = await versions(slideId);
    expect(vrows).toHaveLength(2);
    expect(vrows[0].version_no).toBe(1);
    expect(vrows[0].html_body).toBe("<section>original</section>");
    expect(vrows[1].version_no).toBe(2);
    expect(vrows[1].html_body).toBe("<section>approved revision</section>");

    // version_no monotonic + parent chain links v2 -> v1.
    expect(vrows[1].parent_version_id).toBe(v1);
    // the new version is attributed to the proposal that produced it.
    expect(vrows[1].source_edit_id).toBe(editId);

    // 2. denorm cache synced to the new version.
    const slide = await readSlide(slideId);
    expect(slide.html_body).toBe("<section>approved revision</section>");
    expect(slide.current_version_id).toBe(vrows[1].id);

    // 3. edit flipped to applied, resolver stamped to the approver.
    const edit = await readEdit(editId);
    expect(edit.status).toBe("applied");
    expect(edit.resolved_by).toBe(reviewer);
    expect(edit.resolved_at).not.toBeNull();
  });

  it("keeps version_no monotonic across two sequential approvals", async () => {
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

    const vrows = await versions(slideId);
    expect(vrows.map((v) => v.version_no)).toEqual([1, 2, 3]);
    expect(vrows[2].parent_version_id).toBe(v2);
    expect((await readSlide(slideId)).html_body).toBe("<section>v3</section>");
  });

  it("rejects applying a non-pending edit (no second version)", async () => {
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
    });
    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: proposer,
      newContent: "<section>v2</section>",
      baseVersionId: v1,
    });

    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [editId]);

    // Second apply of the now-applied edit must error and add no version.
    await asUser(db, reviewer);
    await expect(
      db.query("select public.canvas_apply_edit($1)", [editId]),
    ).rejects.toThrow(/not pending/);
    expect(await versions(slideId)).toHaveLength(2);
  });

  it("enforces optimistic concurrency via _expected_revision", async () => {
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
    });
    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: proposer,
      newContent: "<section>v2</section>",
      baseVersionId: v1,
    });

    // Edit is at revision 0; approving against an expected revision of 1
    // (i.e. "I reviewed a newer revision") must be refused.
    await asUser(db, reviewer);
    await expect(
      db.query("select public.canvas_apply_edit($1, $2)", [editId, 1]),
    ).rejects.toThrow(/proposal_changed_since_review/);
    expect(await versions(slideId)).toHaveLength(1);
  });
});

describe("canvas_apply_edit: self-approval guard (0034 / 0039 / 0040)", () => {
  it("rejects a plain member approving their OWN edit when self-approval is OFF", async () => {
    const ws = await makeWorkspace(db); // default canvas_allow_self_approval = false
    const proposer = await makeUser(db);
    await addMembership(db, ws, proposer, "member");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: proposer });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: proposer,
    });
    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: proposer,
      newContent: "<section>self</section>",
      baseVersionId: v1,
    });

    await asUser(db, proposer);
    await expect(
      db.query("select public.canvas_apply_edit($1)", [editId]),
    ).rejects.toThrow(/only workspace admins can approve their own proposal/);
    expect(await versions(slideId)).toHaveLength(1);
    expect((await readEdit(editId)).status).toBe("pending");
  });

  it("allows the proposer to self-approve when the workspace opted IN", async () => {
    const ws = await makeWorkspace(db);
    await db.query(
      "update public.workspaces set canvas_allow_self_approval = true where id = $1",
      [ws],
    );
    const proposer = await makeUser(db);
    await addMembership(db, ws, proposer, "member");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: proposer });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: proposer,
    });
    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: proposer,
      newContent: "<section>self-ok</section>",
      baseVersionId: v1,
    });

    await asUser(db, proposer);
    await db.query("select public.canvas_apply_edit($1)", [editId]);
    expect(await versions(slideId)).toHaveLength(2);
    expect((await readEdit(editId)).status).toBe("applied");
  });

  it("allows a workspace ADMIN to approve their own edit even with self-approval OFF", async () => {
    const ws = await makeWorkspace(db);
    const admin = await makeUser(db);
    await addMembership(db, ws, admin, "admin");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: admin });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: admin,
    });
    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: admin,
      newContent: "<section>admin-self</section>",
      baseVersionId: v1,
    });

    await asUser(db, admin);
    await db.query("select public.canvas_apply_edit($1)", [editId]);
    expect((await readEdit(editId)).status).toBe("applied");
  });

  it("lets a plain member self-apply a REVERT of an edit they themselves resolved (0040 carve-out)", async () => {
    // Reproduces the 0040 incident: a member who APPROVED someone else's edit
    // then clicks Undo. The Undo is a self-proposed revert; without the carve-
    // out the self-approval guard rejected it ("needs a reviewer"). Undoing your
    // own approval is within your authority, so it must apply.
    const ws = await makeWorkspace(db); // self-approval OFF
    const author = await makeUser(db);
    const reviewer = await makeUser(db);
    await addMembership(db, ws, author, "member");
    await addMembership(db, ws, reviewer, "member");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: author });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: author,
      htmlBody: "<section>v1</section>",
    });

    // author proposes, reviewer approves -> the applied edit reviewer "owns".
    const original = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: author,
      newContent: "<section>v2</section>",
      baseVersionId: v1,
    });
    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [original]);
    const v2 = (await readSlide(slideId)).current_version_id;

    // reviewer now proposes a revert back to v1 (slide_edit payload) linked to
    // the applied edit they resolved, and self-applies it.
    const revert = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_edit",
      proposedBy: reviewer,
      payload: { html_body: "<section>v1</section>" },
      baseVersionId: v2,
      revertsEditId: original,
      rationale: "undo",
    });
    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [revert]);

    expect((await readEdit(revert)).status).toBe("applied");
    expect((await readSlide(slideId)).html_body).toBe("<section>v1</section>");
  });

  it("still blocks self-applying a revert of an edit someone ELSE resolved", async () => {
    // The carve-out is scoped to "an edit I resolved". A member reverting an
    // edit a DIFFERENT person approved takes the normal peer-review path.
    const ws = await makeWorkspace(db); // self-approval OFF
    const author = await makeUser(db);
    const approver = await makeUser(db);
    const other = await makeUser(db);
    await addMembership(db, ws, author, "member");
    await addMembership(db, ws, approver, "member");
    await addMembership(db, ws, other, "member");
    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: author });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: author,
    });

    const original = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_html",
      proposedBy: author,
      newContent: "<section>v2</section>",
      baseVersionId: v1,
    });
    await asUser(db, approver); // APPROVER resolves it
    await db.query("select public.canvas_apply_edit($1)", [original]);
    const v2 = (await readSlide(slideId)).current_version_id;

    // `other` proposes a revert and tries to self-apply: not the resolver, so
    // the carve-out does not apply and the guard fires.
    const revert = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: "slide_edit",
      proposedBy: other,
      payload: { html_body: "<section>v1</section>" },
      baseVersionId: v2,
      revertsEditId: original,
    });
    await asUser(db, other);
    await expect(
      db.query("select public.canvas_apply_edit($1)", [revert]),
    ).rejects.toThrow(/only workspace admins can approve their own proposal/);
    expect((await readEdit(revert)).status).toBe("pending");
  });
});
