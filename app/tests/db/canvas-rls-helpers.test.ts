// ============================================================
// canvas_can_read_deck / canvas_can_edit_deck — the deck access boundary.
// ============================================================
// These two SECURITY DEFINER helpers are the single source of truth for "who
// can see / edit this deck": every deck-child RLS policy and canvas_apply_edit
// route through them. The grant/deny matrix below pins the contract across
// roles and visibilities, plus the two sharing paths that have each caused a
// prod incident:
//   • guest exclusion (0025): a `guest` membership grants NO blanket access; it
//     reaches a deck ONLY via an explicit canvas_deck_member row.
//   • project-sharing cascade (0046): a project member reaches every deck in
//     the project regardless of the deck's own visibility; a project EDITOR can
//     edit them, a project VIEWER can only read.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  freshDb,
  makeUser,
  makeWorkspace,
  addMembership,
  makeDeck,
  callBoolHelper,
  type Pg,
} from "./setup";
import { randomUUID } from "node:crypto";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

/** Grant a per-deck membership (the guest / explicit-share path). */
async function addDeckMember(
  deckId: string,
  workspaceId: string,
  userId: string,
  role: "viewer" | "editor",
) {
  await db.query(
    `insert into public.canvas_deck_member (deck_id, workspace_id, user_id, role)
     values ($1, $2, $3, $4)`,
    [deckId, workspaceId, userId, role],
  );
}

/** Create a project and a per-project membership. */
async function makeProject(workspaceId: string, createdBy: string, visibility = "private") {
  const id = randomUUID();
  // canvas_project has a unique (workspace_id, name); use the id to keep names
  // distinct when a test builds two projects in the same workspace.
  await db.query(
    `insert into public.canvas_project (id, workspace_id, name, visibility, created_by)
     values ($1, $2, $3, $4, $5)`,
    [id, workspaceId, `Project ${id.slice(0, 8)}`, visibility, createdBy],
  );
  return id;
}
async function addProjectMember(
  projectId: string,
  workspaceId: string,
  userId: string,
  role: "viewer" | "editor",
) {
  await db.query(
    `insert into public.canvas_project_member (project_id, workspace_id, user_id, role)
     values ($1, $2, $3, $4)`,
    [projectId, workspaceId, userId, role],
  );
}

describe("canvas_can_read_deck / canvas_can_edit_deck: role × visibility matrix", () => {
  it("workspace-visible deck: full members read+edit, admin/owner read+edit, non-member denied", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const admin = await makeUser(db);
    const member = await makeUser(db);
    const stranger = await makeUser(db); // member of NO workspace
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, admin, "admin");
    await addMembership(db, ws, member, "member");

    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "workspace",
    });

    for (const u of [owner, admin, member]) {
      expect(await callBoolHelper(db, u, "canvas_can_read_deck", deckId)).toBe(true);
      expect(await callBoolHelper(db, u, "canvas_can_edit_deck", deckId)).toBe(true);
    }
    expect(await callBoolHelper(db, stranger, "canvas_can_read_deck", deckId)).toBe(false);
    expect(await callBoolHelper(db, stranger, "canvas_can_edit_deck", deckId)).toBe(false);
    // Anonymous (auth.uid() NULL) is denied.
    expect(await callBoolHelper(db, null, "canvas_can_read_deck", deckId)).toBe(false);
  });

  it("private deck: only admin/owner (and explicit deck members) reach it; plain members do NOT", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const admin = await makeUser(db);
    const member = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, admin, "admin");
    await addMembership(db, ws, member, "member");

    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
    });

    // admin/owner always reach (the is_workspace_admin_or_owner branch).
    expect(await callBoolHelper(db, owner, "canvas_can_read_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, owner, "canvas_can_edit_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, admin, "canvas_can_edit_deck", deckId)).toBe(true);

    // The workspace-visibility shortcut does NOT fire for a private deck, so a
    // plain member with no explicit grant is denied both.
    expect(await callBoolHelper(db, member, "canvas_can_read_deck", deckId)).toBe(false);
    expect(await callBoolHelper(db, member, "canvas_can_edit_deck", deckId)).toBe(false);
  });

  it("guest membership grants NO blanket access (0025): denied until an explicit deck-member row", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const guest = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, guest, "guest");

    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "workspace",
    });

    // A guest is excluded from the visibility='workspace' shortcut
    // (is_workspace_member_full excludes guests).
    expect(await callBoolHelper(db, guest, "canvas_can_read_deck", deckId)).toBe(false);
    expect(await callBoolHelper(db, guest, "canvas_can_edit_deck", deckId)).toBe(false);

    // An explicit viewer deck-member row opens READ only.
    await addDeckMember(deckId, ws, guest, "viewer");
    expect(await callBoolHelper(db, guest, "canvas_can_read_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, guest, "canvas_can_edit_deck", deckId)).toBe(false);
  });

  it("explicit deck-member editor row grants edit on a private deck", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const collaborator = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, collaborator, "member");

    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
    });
    // Plain member denied until the explicit grant.
    expect(await callBoolHelper(db, collaborator, "canvas_can_read_deck", deckId)).toBe(false);

    await addDeckMember(deckId, ws, collaborator, "editor");
    expect(await callBoolHelper(db, collaborator, "canvas_can_read_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, collaborator, "canvas_can_edit_deck", deckId)).toBe(true);
  });
});

describe("canvas_can_*_deck: project-sharing cascade (0046)", () => {
  it("a project EDITOR can read AND edit a PRIVATE deck grouped under that project", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const sharee = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, sharee, "member");

    const projectId = await makeProject(ws, owner);
    // Private deck — without the project branch, sharee would be denied.
    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
      projectId,
    });

    // No access before the project membership.
    expect(await callBoolHelper(db, sharee, "canvas_can_read_deck", deckId)).toBe(false);

    await addProjectMember(projectId, ws, sharee, "editor");
    // The 0046 cascade reaches the deck regardless of its own visibility.
    expect(await callBoolHelper(db, sharee, "canvas_can_read_deck", deckId)).toBe(true);
    expect(await callBoolHelper(db, sharee, "canvas_can_edit_deck", deckId)).toBe(true);
  });

  it("a project VIEWER can READ but NOT edit a deck in the project", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const viewer = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, viewer, "member");

    const projectId = await makeProject(ws, owner);
    const deckId = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
      projectId,
    });

    await addProjectMember(projectId, ws, viewer, "viewer");
    expect(await callBoolHelper(db, viewer, "canvas_can_read_deck", deckId)).toBe(true);
    // Viewers fall through to the read helper only.
    expect(await callBoolHelper(db, viewer, "canvas_can_edit_deck", deckId)).toBe(false);
  });

  it("project membership does NOT leak to a deck in a DIFFERENT project (cascade is scoped)", async () => {
    const ws = await makeWorkspace(db);
    const owner = await makeUser(db);
    const sharee = await makeUser(db);
    await addMembership(db, ws, owner, "owner");
    await addMembership(db, ws, sharee, "member");

    const sharedProject = await makeProject(ws, owner);
    const otherProject = await makeProject(ws, owner);
    await addProjectMember(sharedProject, ws, sharee, "editor");

    // A private deck in the OTHER project must stay inaccessible.
    const otherDeck = await makeDeck(db, {
      workspaceId: ws,
      createdBy: owner,
      visibility: "private",
      projectId: otherProject,
    });
    expect(await callBoolHelper(db, sharee, "canvas_can_read_deck", otherDeck)).toBe(false);
    expect(await callBoolHelper(db, sharee, "canvas_can_edit_deck", otherDeck)).toBe(false);
  });
});
