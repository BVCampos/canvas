import { beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  asUser,
  freshDb,
  makeDeck,
  makePendingSlideEdit,
  makeSlide,
  makeUser,
  makeWorkspace,
  type Pg,
} from "./setup";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

describe("proposal lifecycle notifications", () => {
  it("routes waiting work to the slide owner and an applied receipt to the proposer", async () => {
    const workspaceId = await makeWorkspace(db);
    const proposer = await makeUser(db);
    const reviewer = await makeUser(db);
    await addMembership(db, workspaceId, proposer, "member");
    await addMembership(db, workspaceId, reviewer, "member");

    const deckId = await makeDeck(db, {
      workspaceId,
      createdBy: reviewer,
    });
    const { slideId, versionId } = await makeSlide(db, {
      workspaceId,
      deckId,
      position: 0,
      createdBy: reviewer,
      htmlBody: "<section>before</section>",
    });
    await db.query(
      "update public.canvas_deck_slide set owner_id = $1 where id = $2",
      [reviewer, slideId],
    );

    const editId = await makePendingSlideEdit(db, {
      workspaceId,
      deckId,
      slideId,
      kind: "slide_edit",
      proposedBy: proposer,
      proposedByKind: "claude",
      payload: { html_body: "<section>after</section>" },
      baseVersionId: versionId,
      rationale: "Tighten the opening slide",
    });

    const waiting = await db.query<{
      user_id: string;
      kind: string;
      edit_id: string;
      body_preview: string;
    }>(
      "select user_id, kind, edit_id, body_preview from public.canvas_notification where edit_id = $1",
      [editId],
    );
    expect(waiting.rows).toEqual([
      {
        user_id: reviewer,
        kind: "proposal_waiting",
        edit_id: editId,
        body_preview: "Tighten the opening slide",
      },
    ]);

    await asUser(db, reviewer);
    await db.query("select public.canvas_apply_edit($1)", [editId]);

    const lifecycle = await db.query<{ user_id: string; kind: string }>(
      "select user_id, kind from public.canvas_notification where edit_id = $1 order by created_at, kind",
      [editId],
    );
    expect(lifecycle.rows).toEqual([
      { user_id: reviewer, kind: "proposal_waiting" },
      { user_id: proposer, kind: "proposal_applied" },
    ]);
  });

  it("falls back to an owner/admin reviewer and reports rejection", async () => {
    const workspaceId = await makeWorkspace(db);
    const proposer = await makeUser(db);
    const admin = await makeUser(db);
    await addMembership(db, workspaceId, proposer, "member");
    await addMembership(db, workspaceId, admin, "admin");
    const deckId = await makeDeck(db, { workspaceId, createdBy: proposer });

    const editId = await makePendingSlideEdit(db, {
      workspaceId,
      deckId,
      kind: "deck_title",
      proposedBy: proposer,
      proposedByKind: "claude",
      newContent: "New title",
      rationale: "Clarify the deck name",
    });

    await asUser(db, admin);
    await db.query("select public.canvas_reject_edit($1, $2)", [editId, "Not yet"]);

    const rows = await db.query<{ user_id: string; kind: string }>(
      "select user_id, kind from public.canvas_notification where edit_id = $1 order by created_at, kind",
      [editId],
    );
    expect(rows.rows).toEqual([
      { user_id: admin, kind: "proposal_waiting" },
      { user_id: proposer, kind: "proposal_rejected" },
    ]);
  });
});

