// ============================================================
// proposeSlideHtmlEdit's row — the member-hand-edit propose path, in real SQL.
// ============================================================
// Feature: a workspace member who can't direct-save a slide hand-edits it in
// the Adjust / Edit-text / Inspect surfaces and Save routes through a PENDING
// proposal instead of a direct commit (see src/app/canvases/proposal-actions.ts
// proposeSlideHtmlEdit, shaped by src/lib/canvas/propose-slide-html.ts).
//
// The pure builder is unit-tested in tests/propose-slide-html.test.ts. This
// proves the row it produces is actually ACCEPTED by the database:
//   • the canvas_deck_edit_content_shape_chk CHECK constraint (migration 0032)
//     admits kind='slide_edit' + new_content=null + new_slide_payload with at
//     least one string field, with proposed_by_kind='user';
//   • canvas_apply_edit's slide_edit branch lands html_body, slide_styles, and
//     title from the bundle as one new version.
// Mirrors the makePendingSlideEdit insert proposeSlideHtmlEdit performs.
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
import { buildProposeSlideEditRow } from "../../src/lib/canvas/propose-slide-html";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

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

describe("proposeSlideHtmlEdit row: insert + apply", () => {
  it("inserts a member's slide_edit bundle (proposed_by_kind='user') and applies all three fields", async () => {
    const ws = await makeWorkspace(db);
    const member = await makeUser(db);
    const reviewer = await makeUser(db);
    await addMembership(db, ws, member, "member");
    await addMembership(db, ws, reviewer, "member");

    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: reviewer });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: reviewer, // the member is NOT the slide owner — the propose case
      title: "Old label",
      htmlBody: "<section>original</section>",
      slideStyles: ".a{color:black}",
    });

    // Shape the row exactly as proposeSlideHtmlEdit does, via the pure builder.
    const built = buildProposeSlideEditRow({
      slideId,
      htmlBody: "<section>member revision</section>",
      slideStyles: ".a{color:blue}",
      title: "New label",
      rationale: "member fix",
      baseVersionId: v1,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Insert with the builder's payload — the CHECK constraint must admit it.
    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: built.row.kind,
      proposedBy: member,
      proposedByKind: built.row.proposed_by_kind,
      payload: built.row.new_slide_payload,
      baseVersionId: built.row.base_version_id,
      rationale: built.row.rationale,
    });

    // A reviewer approves (no self-approval question — member ≠ reviewer).
    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [editId]);

    const slide = await readSlide(slideId);
    expect(slide.html_body).toBe("<section>member revision</section>");
    expect(slide.slide_styles).toBe(".a{color:blue}");
    expect(slide.title).toBe("New label");
    expect(slide.current_version_id).not.toBe(v1);

    const { rows } = await db.query<{ status: string }>(
      "select status from public.canvas_deck_edit where id = $1",
      [editId],
    );
    expect(rows[0].status).toBe("applied");
  });

  it("admits an html-only bundle and leaves slide_styles/title untouched on apply", async () => {
    const ws = await makeWorkspace(db);
    const member = await makeUser(db);
    const reviewer = await makeUser(db);
    await addMembership(db, ws, member, "member");
    await addMembership(db, ws, reviewer, "member");

    const deckId = await makeDeck(db, { workspaceId: ws, createdBy: reviewer });
    const { slideId, versionId: v1 } = await makeSlide(db, {
      workspaceId: ws,
      deckId,
      position: 0,
      createdBy: reviewer,
      title: "Keep me",
      htmlBody: "<section>v1</section>",
      slideStyles: ".keep{}",
    });

    // The common case: the visual / code editor sends html only.
    const built = buildProposeSlideEditRow({
      slideId,
      htmlBody: "<section>html only</section>",
      baseVersionId: v1,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect("slide_styles" in built.row.new_slide_payload).toBe(false);
    expect("title" in built.row.new_slide_payload).toBe(false);

    const editId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId,
      slideId,
      kind: built.row.kind,
      proposedBy: member,
      proposedByKind: built.row.proposed_by_kind,
      payload: built.row.new_slide_payload,
      baseVersionId: built.row.base_version_id,
    });

    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [editId]);

    const slide = await readSlide(slideId);
    expect(slide.html_body).toBe("<section>html only</section>");
    // Omitted fields keep their current value (coalesce in the apply RPC).
    expect(slide.slide_styles).toBe(".keep{}");
    expect(slide.title).toBe("Keep me");
  });
});
