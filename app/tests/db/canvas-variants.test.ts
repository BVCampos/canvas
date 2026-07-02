// ============================================================
// A/B slide variants (migration 0066) — the pick-one gate, in real SQL.
// ============================================================
// The hazard this migration exists to close: canvas_apply_edit has NO
// slide-staleness guard, so two sibling variants applied in sequence would
// silently last-writer-win. The assertions pin the three protections:
//   • canvas_apply_variant applies the picked edit and supersedes the pending
//     siblings in the SAME transaction;
//   • the generic apply path fail-closes on a grouped row with pending
//     siblings (variant_pick_required);
//   • a failed inner apply rolls the sibling sweep back (atomicity).
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
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

async function editStatus(editId: string) {
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

/** Owner + proposer + deck + slide + a 3-member variant set. */
async function variantFixture() {
  const owner = await makeUser(db, "owner@x.test");
  const proposer = await makeUser(db, "proposer@x.test");
  const ws = await makeWorkspace(db);
  await addMembership(db, ws, owner, "owner");
  await addMembership(db, ws, proposer, "member");
  const deck = await makeDeck(db, { workspaceId: ws, createdBy: owner });
  const { slideId: slide } = await makeSlide(db, {
    workspaceId: ws,
    deckId: deck,
    position: 0,
    createdBy: owner,
    htmlBody: "<section class='slide'>original</section>",
  });
  const groupId = randomUUID();
  const ids: string[] = [];
  for (const label of ["A", "B", "C"]) {
    ids.push(
      await makePendingSlideEdit(db, {
        workspaceId: ws,
        deckId: deck,
        slideId: slide,
        kind: "slide_edit",
        proposedBy: proposer,
        proposedByKind: "claude",
        payload: { html_body: `<section class='slide'>variant ${label}</section>` },
        variantGroupId: groupId,
      }),
    );
  }
  return { owner, proposer, ws, deck, slide, groupId, ids };
}

describe("canvas_apply_variant", () => {
  it("applies the pick and supersedes the pending siblings in one call", async () => {
    const { owner, slide, ids } = await variantFixture();
    await asUser(db, owner);
    await db.query("select public.canvas_apply_variant($1)", [ids[1]]);

    expect((await editStatus(ids[1])).status).toBe("applied");
    const a = await editStatus(ids[0]);
    const c = await editStatus(ids[2]);
    expect(a.status).toBe("superseded");
    expect(c.status).toBe("superseded");
    expect(a.resolved_by).toBe(owner);
    expect(a.resolved_at).not.toBeNull();

    const { rows } = await db.query<{ html_body: string }>(
      "select html_body from public.canvas_deck_slide where id = $1",
      [slide],
    );
    expect(rows[0].html_body).toContain("variant B");
  });

  it("refuses an edit that is not part of a variant set", async () => {
    const { owner, ws, deck, slide } = await variantFixture();
    const lone = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId: deck,
      slideId: slide,
      kind: "slide_edit",
      proposedBy: owner,
      payload: { html_body: "<section class='slide'>lone</section>" },
    });
    await asUser(db, owner);
    await expect(
      db.query("select public.canvas_apply_variant($1)", [lone]),
    ).rejects.toThrow(/not part of a variant set/);
  });

  it("refuses a second pick from the same group (sibling no longer pending)", async () => {
    const { owner, ids } = await variantFixture();
    await asUser(db, owner);
    await db.query("select public.canvas_apply_variant($1)", [ids[0]]);
    await expect(
      db.query("select public.canvas_apply_variant($1)", [ids[1]]),
    ).rejects.toThrow(/not pending/);
  });

  it("blocks a caller without deck edit rights", async () => {
    const { ws, ids } = await variantFixture();
    const outsider = await makeUser(db, "outsider@x.test");
    await addMembership(db, ws, outsider, "guest");
    await asUser(db, outsider);
    await expect(
      db.query("select public.canvas_apply_variant($1)", [ids[0]]),
    ).rejects.toThrow(/not found or not accessible/);
  });

  it("rolls the sibling sweep back when the inner apply fails (atomicity)", async () => {
    const { proposer, ids } = await variantFixture();
    // The proposer picking their own variant trips the self-approval guard
    // inside canvas_apply_edit (plain member, workspace not opted in) — the
    // whole transaction, sweep included, must roll back.
    await asUser(db, proposer);
    await expect(
      db.query("select public.canvas_apply_variant($1)", [ids[0]]),
    ).rejects.toThrow(/own proposal/);
    expect((await editStatus(ids[1])).status).toBe("pending");
    expect((await editStatus(ids[2])).status).toBe("pending");
  });
});

describe("generic apply on a grouped row", () => {
  it("fail-closes while siblings are pending (variant_pick_required)", async () => {
    const { owner, ids } = await variantFixture();
    await asUser(db, owner);
    await expect(
      db.query("select public.canvas_apply_edit($1)", [ids[0]]),
    ).rejects.toThrow(/variant_pick_required/);
    // Nothing changed.
    expect((await editStatus(ids[0])).status).toBe("pending");
    expect((await editStatus(ids[1])).status).toBe("pending");
  });

  it("allows the generic path once the row is the group's only survivor", async () => {
    const { owner, ids } = await variantFixture();
    await asUser(db, owner);
    // Reject two of three; the survivor is no longer a choice.
    await db.query(
      "update public.canvas_deck_edit set status = 'rejected', resolved_by = $2, resolved_at = now() where id = any($1)",
      [[ids[0], ids[1]], owner],
    );
    await db.query("select public.canvas_apply_edit($1)", [ids[2]]);
    expect((await editStatus(ids[2])).status).toBe("applied");
  });
});

describe("variant_group_id immutability", () => {
  it("is write-once: re-pointing an existing row is rejected", async () => {
    const { owner, ids } = await variantFixture();
    await asUser(db, owner);
    await expect(
      db.query(
        "update public.canvas_deck_edit set variant_group_id = $2 where id = $1",
        [ids[0], randomUUID()],
      ),
    ).rejects.toThrow(/variant_group_id is immutable/);
  });
});

// ============================================================
// 0068 — the group is scoped to ONE slide of ONE deck. The group id is
// readable off any deck via list_proposals, so without slide+deck scoping a
// row carrying a foreign group id could sweep another deck's pending variants
// (or the RLS door could let a human mint such a row at all).
// ============================================================

describe("variant group cross-deck scope (0068)", () => {
  it("a foreign row sharing the group id cannot supersede another deck's pending variants", async () => {
    // Deck B holds a real 3-member variant group for its own slide.
    const { owner, ws, ids: bIds, groupId } = await variantFixture();

    // Same workspace, a second deck A with its own slide, created by a griefer.
    const griefer = await makeUser(db, "griefer@x.test");
    await addMembership(db, ws, griefer, "member");
    const deckA = await makeDeck(db, { workspaceId: ws, createdBy: griefer });
    const { slideId: slideA } = await makeSlide(db, {
      workspaceId: ws,
      deckId: deckA,
      position: 0,
      createdBy: griefer,
      htmlBody: "<section class='slide'>A original</section>",
    });

    // The grief: a proposal on deck A's OWN slide carrying deck B's group id.
    // Inserted directly (as the service-role/PostgREST path would) because the
    // 0068 RLS guard blocks a non-null group id from a user JWT.
    const griefId = await makePendingSlideEdit(db, {
      workspaceId: ws,
      deckId: deckA,
      slideId: slideA,
      kind: "slide_edit",
      proposedBy: griefer,
      proposedByKind: "claude",
      payload: { html_body: "<section class='slide'>A grief</section>" },
      variantGroupId: groupId,
    });

    // The workspace owner (a non-proposer, so no self-approval trip) picks the
    // grief row. It is the sole member of {group, deckA, slideA}, so the pick
    // applies — but the scoped sweep leaves deck B alone.
    await asUser(db, owner);
    await db.query("select public.canvas_apply_variant($1)", [griefId]);

    expect((await editStatus(griefId)).status).toBe("applied");
    for (const id of bIds) {
      expect((await editStatus(id)).status).toBe("pending");
    }
  });
});

describe("human proposals cannot carry a variant_group_id (0068 RLS)", () => {
  it("the insert policy requires variant_group_id IS NULL", async () => {
    // The harness runs RPCs as superuser (bypassing RLS), so we assert the
    // policy DEFINITION rather than exercise enforcement — the pg_policies
    // convention from workspace-openrouter.test.ts. Only the service-role MCP
    // path mints groups; a human RLS insert must fail the WITH CHECK.
    const { rows } = await db.query<{ with_check: string | null }>(
      `select with_check
         from pg_policies
        where schemaname = 'public'
          and tablename = 'canvas_deck_edit'
          and policyname = 'editors propose edits'`,
    );
    expect(rows).toHaveLength(1);
    const check = (rows[0].with_check ?? "").toLowerCase();
    expect(check).toContain("variant_group_id is null");
    // The original conjuncts survive the re-creation.
    expect(check).toContain("canvas_can_edit_deck");
    expect(check).toContain("proposed_by");
  });
});
