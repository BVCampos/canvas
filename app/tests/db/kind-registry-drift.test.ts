// ============================================================
// Kind-registry drift guard — SQL enum vs TS taxonomy, in real SQL.
// ============================================================
// The proposal-`kind` taxonomy lives on multiple surfaces: the SQL
// canvas_edit_kind enum (extended over many migrations via ALTER TYPE ADD
// VALUE), the TS PROPOSAL_KINDS / KIND_META in proposal-types.ts, and the
// per-kind ladders inside canvas_apply_edit / canvas_update_edit. Historically
// they were kept "in lockstep" by a prose comment — the exact hazard that lets a
// kind get added to one surface and forgotten on another (asProposalKind then
// silently reclassifies the forgotten kind as slide_html).
//
// This test makes the SQL enum and the TS list lockstep ENFORCED: it reads the
// real enum (after every ALTER TYPE ADD VALUE migration applies under pglite)
// and asserts it equals PROPOSAL_KINDS. Same for the status enum. Adding a kind
// to one surface and not the other now fails CI instead of shipping silently.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, type Pg } from "./setup";
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
} from "../../src/lib/canvas/proposal-types";

let db: Pg;
beforeEach(async () => {
  ({ db } = await freshDb());
});

async function enumValues(typeName: string): Promise<string[]> {
  const { rows } = await db.query<{ v: string }>(
    `select e.enumlabel as v
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname = $1
      order by e.enumsortorder`,
    [typeName],
  );
  return rows.map((r) => r.v);
}

describe("kind registry drift guard", () => {
  it("canvas_edit_kind enum == TS PROPOSAL_KINDS (no surface drift)", async () => {
    const dbKinds = await enumValues("canvas_edit_kind");
    expect(dbKinds.length).toBeGreaterThan(0); // sanity: the enum loaded
    expect(new Set(dbKinds)).toEqual(new Set(PROPOSAL_KINDS));
  });

  it("canvas_edit_status enum == TS PROPOSAL_STATUSES", async () => {
    const dbStatuses = await enumValues("canvas_edit_status");
    expect(new Set(dbStatuses)).toEqual(new Set([...PROPOSAL_STATUSES]));
  });
});
