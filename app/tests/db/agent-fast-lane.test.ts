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

// Defaults produce the fully-opted-in solo fixture the happy path applies on;
// each option knocks out exactly one of canvas_apply_trusted_agent_edit's
// gates so the refusal tests below pin the SQL predicate set one by one.
async function optedInFixture(
  opts: {
    selfApproval?: boolean;
    fastLane?: boolean;
    role?: "member" | "guest";
    deckCreatedByOther?: boolean;
  } = {},
) {
  const workspaceId = await makeWorkspace(db);
  const actorId = await makeUser(db);
  await addMembership(db, workspaceId, actorId, opts.role ?? "member");
  let otherId: string | null = null;
  if (opts.deckCreatedByOther) {
    otherId = await makeUser(db);
    await addMembership(db, workspaceId, otherId, "member");
  }
  if (opts.selfApproval ?? true) {
    await db.query(
      "update public.workspaces set canvas_allow_self_approval = true where id = $1",
      [workspaceId],
    );
  }
  const deckId = await makeDeck(db, {
    workspaceId,
    createdBy: opts.deckCreatedByOther ? (otherId as string) : actorId,
  });
  if (opts.fastLane ?? true) {
    await db.query(
      "update public.canvas_deck set agent_fast_lane_enabled = true where id = $1",
      [deckId],
    );
  }
  const { slideId, versionId } = await makeSlide(db, {
    workspaceId,
    deckId,
    position: 0,
    createdBy: actorId,
    htmlBody: '<section class="slide"><p>Before</p></section>',
  });
  return { workspaceId, actorId, otherId, deckId, slideId, versionId };
}

type Fixture = Awaited<ReturnType<typeof optedInFixture>>;

// An agent patch that passes every proposal-side gate (pending, claude,
// slide_edit, eligible, rendered) — so each test isolates one actor-side gate.
async function eligibleRenderedPatch(
  fixture: Fixture,
  proposedBy?: string,
): Promise<string> {
  return makePendingSlideEdit(db, {
    workspaceId: fixture.workspaceId,
    deckId: fixture.deckId,
    slideId: fixture.slideId,
    kind: "slide_edit",
    proposedBy: proposedBy ?? fixture.actorId,
    proposedByKind: "claude",
    payload: { html_body: '<section class="slide"><p>After</p></section>' },
    baseVersionId: fixture.versionId,
    autoApplyEligible: true,
    agentRenderedAt: new Date().toISOString(),
  });
}

describe("trusted agent fast lane", () => {
  it("applies an eligible rendered patch owned by the proposer", async () => {
    const fixture = await optedInFixture();
    const editId = await makePendingSlideEdit(db, {
      workspaceId: fixture.workspaceId,
      deckId: fixture.deckId,
      slideId: fixture.slideId,
      kind: "slide_edit",
      proposedBy: fixture.actorId,
      proposedByKind: "claude",
      payload: {
        html_body: '<section class="slide"><p>After</p></section>',
      },
      baseVersionId: fixture.versionId,
      autoApplyEligible: true,
      agentRenderedAt: new Date().toISOString(),
    });

    await asUser(db, fixture.actorId);
    const result = await db.query<{ applied: boolean }>(
      "select public.canvas_apply_trusted_agent_edit($1, $2) as applied",
      [editId, fixture.actorId],
    );
    expect(result.rows[0].applied).toBe(true);

    const state = await db.query<{ status: string; html_body: string }>(
      `select e.status, s.html_body
       from public.canvas_deck_edit e
       join public.canvas_deck_slide s on s.id = e.slide_id
       where e.id = $1`,
      [editId],
    );
    expect(state.rows[0]).toEqual({
      status: "applied",
      html_body: '<section class="slide"><p>After</p></section>',
    });
  });

  it("refuses a patch that has not been rendered", async () => {
    const fixture = await optedInFixture();
    const editId = await makePendingSlideEdit(db, {
      workspaceId: fixture.workspaceId,
      deckId: fixture.deckId,
      slideId: fixture.slideId,
      kind: "slide_edit",
      proposedBy: fixture.actorId,
      proposedByKind: "claude",
      payload: { html_body: '<section class="slide"><p>After</p></section>' },
      baseVersionId: fixture.versionId,
      autoApplyEligible: true,
    });

    await asUser(db, fixture.actorId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        fixture.actorId,
      ]),
    ).rejects.toThrow(/not an eligible pending agent patch/);
  });

  // ---- Refusal paths, one per RPC gate. The TS offer layer (render_proposal's
  // fastLaneOpen + trustedFastLaneAvailable) mirrors these predicates; these
  // tests pin the SQL side so a drifted mirror fails loudly here, not as an
  // offer-then-refuse in production.

  it("refuses to apply someone else's proposal (proposer-identity gate)", async () => {
    const fixture = await optedInFixture();
    const reviewerId = await makeUser(db);
    await addMembership(db, fixture.workspaceId, reviewerId, "member");
    const editId = await eligibleRenderedPatch(fixture);

    await asUser(db, reviewerId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        reviewerId,
      ]),
    ).rejects.toThrow(/not an eligible pending agent patch/);
    // The refusal left the proposal pending for human review, untouched.
    const status = await db.query<{ status: string }>(
      "select status from public.canvas_deck_edit where id = $1",
      [editId],
    );
    expect(status.rows[0].status).toBe("pending");
  });

  it("refuses when workspace self-approval is disabled", async () => {
    const fixture = await optedInFixture({ selfApproval: false });
    const editId = await eligibleRenderedPatch(fixture);

    await asUser(db, fixture.actorId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        fixture.actorId,
      ]),
    ).rejects.toThrow(/workspace self-approval is disabled/);
  });

  it("refuses when the deck is not opted in", async () => {
    const fixture = await optedInFixture({ fastLane: false });
    const editId = await eligibleRenderedPatch(fixture);

    await asUser(db, fixture.actorId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        fixture.actorId,
      ]),
    ).rejects.toThrow(/deck is not opted in/);
  });

  it("refuses a guest actor", async () => {
    const fixture = await optedInFixture({ role: "guest" });
    const editId = await eligibleRenderedPatch(fixture);

    await asUser(db, fixture.actorId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        fixture.actorId,
      ]),
    ).rejects.toThrow(/not a full workspace member/);
  });

  it("refuses a plain member who did not create the deck", async () => {
    const fixture = await optedInFixture({ deckCreatedByOther: true });
    const editId = await eligibleRenderedPatch(fixture);

    await asUser(db, fixture.actorId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        fixture.actorId,
      ]),
    ).rejects.toThrow(/actor does not own this deck/);
  });

  it("refuses when the slide is owned by someone else", async () => {
    const fixture = await optedInFixture();
    const ownerId = await makeUser(db);
    await addMembership(db, fixture.workspaceId, ownerId, "member");
    // The slide gate carves out the slide's CREATOR as well as its owner, so
    // to hit the refusal the slide must be created and owned by someone else.
    await db.query(
      "update public.canvas_deck_slide set owner_id = $1, created_by = $1 where id = $2",
      [ownerId, fixture.slideId],
    );
    const editId = await eligibleRenderedPatch(fixture);

    await asUser(db, fixture.actorId);
    await expect(
      db.query("select public.canvas_apply_trusted_agent_edit($1, $2)", [
        editId,
        fixture.actorId,
      ]),
    ).rejects.toThrow(/actor does not own this slide/);
  });
});

