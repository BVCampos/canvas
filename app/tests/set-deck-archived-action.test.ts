// Server-action test for setDeckArchived — the deck archive/unarchive write
// (migration 0074).
//
// Unlike setDeckStatus, archiving is creator/admin-only (it removes the deck
// from EVERYONE's active list). Because the shared canvas_deck UPDATE policy
// also admits deck-editor members, the action authorizes creator-or-admin IN
// CODE (via is_workspace_admin_or_owner) before writing — the same pattern as
// setDeckAgentFastLane. So the contract under test is:
//   - no authenticated user → not_authenticated, no write
//   - creator OR workspace admin → archive stamps archived_at, unarchive clears it
//   - a deck-editor member who is neither → not_authorized, nothing written
//   - missing / RLS-hidden deck → not_authorized
//   - a real DB error on the write stays distinct from not_authorized
// The user client (incl. the is_workspace_admin_or_owner RPC) is mocked over one
// in-memory store, mirroring set-deck-fast-lane-action.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

const CREATOR = "00000000-0000-0000-0000-0000000000c1";
const ADMIN = "00000000-0000-0000-0000-0000000000a2";
const EDITOR = "00000000-0000-0000-0000-0000000000e3";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b4";
const DECK_ID = "deck-archive-1";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};
let currentUser: { id: string } | null = null;
let isAdminResult = false;
// When set, the next canvas_deck UPDATE resolves with this error (to exercise
// the real-DB-error branch, which must stay distinct from not_authorized).
let updateError: { code: string; message: string } | null = null;

type Filter = { column: string; value: unknown };

class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
  private op: "select" | "update" = "select";
  private updateValues: Row = {};

  constructor(table: string) {
    this.table = table;
  }
  select(_columns?: string) {
    void _columns;
    return this;
  }
  update(values: Row) {
    this.op = "update";
    this.updateValues = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }
  private matchRow(row: Row): boolean {
    return this.filters.every((f) => row[f.column] === f.value);
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = (fakeDb[this.table] ?? []).filter((r) => this.matchRow(r));
    return { data: rows[0] ?? null, error: null };
  }
  then<T>(
    onFulfilled?: (value: { data: Row[] | null; error: { code: string; message: string } | null }) => T,
  ): Promise<T> {
    return this.execute().then(onFulfilled as (v: unknown) => T);
  }
  private async execute(): Promise<{ data: Row[] | null; error: { code: string; message: string } | null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "update") {
      if (updateError) return { data: null, error: updateError };
      const matches = table.filter((r) => this.matchRow(r));
      for (const row of matches) Object.assign(row, this.updateValues);
      return { data: matches, error: null };
    }
    return { data: table.filter((r) => this.matchRow(r)), error: null };
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
  auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
  // Only is_workspace_admin_or_owner is called by setDeckArchived.
  rpc: async () => ({ data: isAdminResult, error: null }),
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mockSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockSupabase }));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setDeckArchived } from "../src/app/canvases/[id]/actions";

function seedDeck(archivedAt: string | null) {
  fakeDb.canvas_deck = [
    {
      id: DECK_ID,
      workspace_id: WORKSPACE,
      created_by: CREATOR,
      archived_at: archivedAt,
    },
  ];
}
const deckRow = () => (fakeDb.canvas_deck ?? []).find((r) => r.id === DECK_ID);

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  currentUser = null;
  isAdminResult = false;
  updateError = null;
  vi.clearAllMocks();
});

describe("setDeckArchived", () => {
  it("requires an authenticated user and writes nothing", async () => {
    seedDeck(null);
    currentUser = null;

    const res = await setDeckArchived(DECK_ID, true);
    expect(res).toEqual({ ok: false, error: "not_authenticated" });
    expect(deckRow()?.archived_at).toBeNull();
  });

  it("archiving by the creator stamps archived_at with a real timestamp", async () => {
    seedDeck(null);
    currentUser = { id: CREATOR };
    isAdminResult = false; // creator path never needs the admin RPC

    const res = await setDeckArchived(DECK_ID, true);
    expect(res).toEqual({ ok: true });
    const stamped = deckRow()?.archived_at;
    expect(typeof stamped).toBe("string");
    // A valid ISO timestamp, not the string "true"/some flag leak.
    expect(Number.isNaN(Date.parse(stamped as string))).toBe(false);
  });

  it("unarchiving by the creator clears archived_at back to null", async () => {
    seedDeck(new Date("2026-01-01T00:00:00.000Z").toISOString());
    currentUser = { id: CREATOR };

    const res = await setDeckArchived(DECK_ID, false);
    expect(res).toEqual({ ok: true });
    expect(deckRow()?.archived_at).toBeNull();
  });

  it("allows a workspace admin/owner who is not the creator", async () => {
    seedDeck(null);
    currentUser = { id: ADMIN };
    isAdminResult = true;

    const res = await setDeckArchived(DECK_ID, true);
    expect(res).toEqual({ ok: true });
    expect(typeof deckRow()?.archived_at).toBe("string");
  });

  it("rejects a deck-editor member who is neither creator nor admin, writing nothing", async () => {
    seedDeck(null);
    currentUser = { id: EDITOR };
    isAdminResult = false; // an editor is not a workspace admin/owner

    const res = await setDeckArchived(DECK_ID, true);
    expect(res).toEqual({ ok: false, error: "not_authorized" });
    expect(deckRow()?.archived_at).toBeNull();
  });

  it("maps a missing / RLS-hidden deck to not_authorized", async () => {
    // No deck seeded → the guard's workspace lookup returns null.
    currentUser = { id: CREATOR };

    const res = await setDeckArchived(DECK_ID, true);
    expect(res).toEqual({ ok: false, error: "not_authorized" });
    expect(fakeDb.canvas_deck ?? []).toHaveLength(0);
  });

  it("surfaces a real DB error distinctly from not_authorized", async () => {
    seedDeck(null);
    currentUser = { id: CREATOR };
    updateError = { code: "XX000", message: "connection reset" };

    const res = await setDeckArchived(DECK_ID, true);
    expect(res).toEqual({ ok: false, error: "connection reset" });
    // The write didn't take (error path), so the row is untouched.
    expect(deckRow()?.archived_at).toBeNull();
  });
});
