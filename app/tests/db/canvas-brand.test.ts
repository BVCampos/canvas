// ============================================================
// canvas_brand (migration 0065) — the brand-kit RLS boundary, in real SQL.
// ============================================================
// Brand is workspace CONFIGURATION, deliberately NOT a proposal kind (0065
// header): edits are direct writes gated purely by RLS. The saveBrand action
// (src/app/settings/brand/actions.ts) upserts through the caller's RLS client
// and treats zero returned rows as denial — so the policies below are the
// ONLY thing standing between a plain member and a brand write. That makes
// them worth pinning in SQL.
//
// HARNESS CAVEAT — read this before reading the assertions.
// This pglite harness runs every statement as the DB superuser (see the auth
// note at the top of tests/db/setup.ts). A Postgres superuser BYPASSES row
// level security unless the table is FORCE'd (canvas_brand only ENABLEs it),
// so we cannot make a raw `insert ... as a member` actually bounce off the
// policy here. I probed the two escape hatches and neither is faithful:
//   • `set role authenticated` then insert → fails with "permission denied
//     for table canvas_brand", a GRANT wall, not a policy denial. The
//     migrations lean on Supabase's default privilege grants to `authenticated`
//     which this bare-Postgres harness never provisions, so that error would
//     be testing a fiction, not 0065's RLS.
//   • FORCE'ing RLS / adding grants in the test would be inventing objects the
//     migration doesn't ship.
// So this file follows the SAME strategy as canvas-rls-helpers.test.ts: it does
// not exercise live per-row enforcement; it pins (a) that the 0065 policies are
// wired to the exact predicates the design intends, read straight out of
// pg_policies, and (b) that those predicates — is_workspace_member_full /
// is_workspace_admin_or_owner — evaluate to the intended grant/deny matrix per
// role. Together those are what make the policies real. The unique constraint
// (a real table constraint) IS enforced under superuser and is pinned directly.
//
// What is therefore NOT pinned here: the row actually disappearing from a
// member's SELECT / an INSERT actually returning zero rows. That path is
// enforcement of the two predicates by Postgres RLS, which this harness can't
// stage; it would need a live Supabase (or a grant+FORCE rig that misrepresents
// the migration).
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  freshDb,
  asUser,
  makeUser,
  makeWorkspace,
  addMembership,
  type Pg,
} from "./setup";

let db: Pg;

beforeEach(async () => {
  ({ db } = await freshDb());
});

/**
 * Build a workspace with one member of each role; returns their uids.
 * Emails are left to makeUser's auto-unique default so the fixture is safe to
 * call more than once in a test (two workspaces, own-brand-per-workspace).
 */
async function workspaceWithRoles() {
  const ws = await makeWorkspace(db);
  const owner = await makeUser(db);
  const admin = await makeUser(db);
  const member = await makeUser(db);
  const guest = await makeUser(db);
  await addMembership(db, ws, owner, "owner");
  await addMembership(db, ws, admin, "admin");
  await addMembership(db, ws, member, "member");
  await addMembership(db, ws, guest, "guest");
  return { ws, owner, admin, member, guest };
}

/** Evaluate the two policy predicates as `uid` against `workspaceId`. */
async function predicatesFor(uid: string | null, workspaceId: string) {
  await asUser(db, uid);
  const { rows } = await db.query<{ full: boolean; admin: boolean }>(
    `select public.is_workspace_member_full($1) as full,
            public.is_workspace_admin_or_owner($1) as admin`,
    [workspaceId],
  );
  return rows[0];
}

type PolicyRow = {
  policyname: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
};

async function brandPolicies(): Promise<Record<string, PolicyRow>> {
  const { rows } = await db.query<PolicyRow>(
    `select policyname, cmd, roles, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = 'canvas_brand'`,
  );
  return Object.fromEntries(rows.map((r) => [r.cmd, r]));
}

// ------------------------------------------------------------
// (a) The 0065 policies are wired to the intended predicates.
// ------------------------------------------------------------
describe("canvas_brand: 0065 policy wiring", () => {
  it("has RLS enabled on the table (otherwise every policy below is dead)", async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class
        where oid = 'public.canvas_brand'::regclass`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it("ships exactly the four SELECT/INSERT/UPDATE/DELETE policies, all to authenticated", async () => {
    const p = await brandPolicies();
    expect(Object.keys(p).sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(p[cmd].roles).toEqual(["authenticated"]);
    }
  });

  it("SELECT is gated on is_workspace_member_full(workspace_id)", async () => {
    const p = await brandPolicies();
    expect(p.SELECT.qual).toContain("is_workspace_member_full");
    expect(p.SELECT.qual).toContain("workspace_id");
  });

  it("INSERT/UPDATE/DELETE are gated on is_workspace_admin_or_owner(workspace_id)", async () => {
    const p = await brandPolicies();
    // INSERT carries the check on the NEW row (with_check), no using-qual.
    expect(p.INSERT.with_check).toContain("is_workspace_admin_or_owner");
    // UPDATE checks BOTH the visible row (qual) and the post-image (with_check)
    // so an admin can neither update a row they can't see nor move it to a
    // workspace they don't administer.
    expect(p.UPDATE.qual).toContain("is_workspace_admin_or_owner");
    expect(p.UPDATE.with_check).toContain("is_workspace_admin_or_owner");
    // DELETE guards the visible row.
    expect(p.DELETE.qual).toContain("is_workspace_admin_or_owner");
  });
});

// ------------------------------------------------------------
// (b) Those predicates produce the intended grant/deny matrix.
//     This is what "admins write, full members read, guests neither" MEANS.
// ------------------------------------------------------------
describe("canvas_brand: the predicates the 0065 policies evaluate", () => {
  it("write predicate (INSERT/UPDATE/DELETE): true for owner+admin, false for member+guest", async () => {
    const { ws, owner, admin, member, guest } = await workspaceWithRoles();
    // Requirement 1: an admin/owner satisfies the insert/update policy.
    expect((await predicatesFor(owner, ws)).admin).toBe(true);
    expect((await predicatesFor(admin, ws)).admin).toBe(true);
    // Requirement 2: a plain member does NOT — so saveBrand's upsert writes
    // zero rows and returns "Only admins and owners can edit the brand kit."
    expect((await predicatesFor(member, ws)).admin).toBe(false);
    expect((await predicatesFor(guest, ws)).admin).toBe(false);
  });

  it("read predicate (SELECT): true for full members (owner/admin/member), false for a guest", async () => {
    const { ws, owner, admin, member, guest } = await workspaceWithRoles();
    // Requirement 3.
    expect((await predicatesFor(owner, ws)).full).toBe(true);
    expect((await predicatesFor(admin, ws)).full).toBe(true);
    expect((await predicatesFor(member, ws)).full).toBe(true);
    expect((await predicatesFor(guest, ws)).full).toBe(false);
  });

  it("predicates are workspace-scoped: an outsider (member of another workspace) is denied both", async () => {
    const { ws } = await workspaceWithRoles();
    const otherWs = await makeWorkspace(db);
    const outsider = await makeUser(db, "outsider@brand.test");
    await addMembership(db, otherWs, outsider, "owner");
    const { full, admin } = await predicatesFor(outsider, ws);
    expect(full).toBe(false);
    expect(admin).toBe(false);
  });

  it("an unauthenticated caller (auth.uid() NULL) satisfies neither predicate", async () => {
    const { ws } = await workspaceWithRoles();
    const { full, admin } = await predicatesFor(null, ws);
    expect(full).toBe(false);
    expect(admin).toBe(false);
  });
});

// ------------------------------------------------------------
// The admin/owner write path is satisfiable end to end (superuser bypasses RLS,
// so this exercises the row shape + updated_at trigger, not enforcement).
// ------------------------------------------------------------
describe("canvas_brand: admin/owner write path", () => {
  async function insertBrand(ws: string, updatedBy: string, name: string, voice: string | null) {
    const { rows } = await db.query<{ id: string; updated_at: string }>(
      `insert into public.canvas_brand (workspace_id, name, tokens, voice, updated_by)
       values ($1, $2, $3, $4, $5)
       returning id, updated_at`,
      [ws, name, JSON.stringify({ colors: { accent: "#2563eb" } }), voice, updatedBy],
    );
    return rows[0];
  }

  it("an inserted brand row lands with its tokens/voice and can be updated (updated_at bumps)", async () => {
    const { ws, owner } = await workspaceWithRoles();
    const inserted = await insertBrand(ws, owner, "21x", "Direct, specific, no hype.");

    const read = await db.query<{ name: string; voice: string; accent: string }>(
      `select name, voice, tokens->'colors'->>'accent' as accent
         from public.canvas_brand where id = $1`,
      [inserted.id],
    );
    expect(read.rows[0]).toMatchObject({
      name: "21x",
      voice: "Direct, specific, no hype.",
      accent: "#2563eb",
    });

    // Force a later wall-clock so the set_updated_at trigger visibly moves it.
    await db.query(
      "update public.canvas_brand set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where id = $1",
      [inserted.id],
    );
    await db.query("update public.canvas_brand set voice = $2 where id = $1", [
      inserted.id,
      "Sharper.",
    ]);
    const after = await db.query<{ voice: string; moved: boolean }>(
      "select voice, updated_at > created_at as moved from public.canvas_brand where id = $1",
      [inserted.id],
    );
    expect(after.rows[0].voice).toBe("Sharper.");
    expect(after.rows[0].moved).toBe(true);
  });
});

// ------------------------------------------------------------
// One brand per workspace — a real UNIQUE constraint, enforced even under
// superuser, so this is pinned directly (not via a predicate).
// ------------------------------------------------------------
describe("canvas_brand: one brand per workspace", () => {
  it("rejects a second brand row for the same workspace", async () => {
    const { ws, owner } = await workspaceWithRoles();
    await db.query(
      "insert into public.canvas_brand (workspace_id, updated_by) values ($1, $2)",
      [ws, owner],
    );
    await expect(
      db.query("insert into public.canvas_brand (workspace_id, updated_by) values ($1, $2)", [
        ws,
        owner,
      ]),
    ).rejects.toThrow(/canvas_brand_workspace_id_key|unique/i);
  });

  it("allows each workspace its own brand (the unique is per-workspace, not global)", async () => {
    const a = await workspaceWithRoles();
    const b = await workspaceWithRoles();
    await db.query("insert into public.canvas_brand (workspace_id, updated_by) values ($1, $2)", [
      a.ws,
      a.owner,
    ]);
    await db.query("insert into public.canvas_brand (workspace_id, updated_by) values ($1, $2)", [
      b.ws,
      b.owner,
    ]);
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from public.canvas_brand",
    );
    expect(rows[0].n).toBe("2");
  });
});
