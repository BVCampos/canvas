// Server-action test for setDeckAgentFastLane — the trusted-fast-lane opt-in.
//
// The flag is security-relevant: the canvas_deck UPDATE RLS policy also permits
// role-'editor' deck members and Postgres RLS is not column-scoped, so the
// action must authorize the caller the same way the UI's `canManageFastLane`
// gate does — workspace owner/admin OR the deck creator — BEFORE writing. A
// non-creator editor must be rejected; the creator and a workspace admin
// allowed. The user client (incl. the is_workspace_admin_or_owner RPC) is
// mocked over one in-memory store, mirroring assistant-cancel-action.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

const CREATOR = "00000000-0000-0000-0000-0000000000c1";
const ADMIN = "00000000-0000-0000-0000-0000000000a2";
const EDITOR = "00000000-0000-0000-0000-0000000000e3";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b4";
const DECK_ID = "deck-fastlane-1";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};
let currentUser: { id: string } | null = null;
let isAdminResult = false;

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
  then<T>(onFulfilled?: (value: { data: Row[]; error: null }) => T): Promise<T> {
    return this.execute().then(onFulfilled as (v: { data: Row[]; error: null }) => T);
  }
  private async execute(): Promise<{ data: Row[]; error: null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "update") {
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
  rpc: async () => ({
    data: isAdminResult,
    error: null,
  }),
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mockSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockSupabase }));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setDeckAgentFastLane } from "../src/app/canvases/[id]/actions";

function seedDeck(createdBy: string) {
  fakeDb.canvas_deck = [
    {
      id: DECK_ID,
      workspace_id: WORKSPACE,
      created_by: createdBy,
      agent_fast_lane_enabled: false,
    },
  ];
}
const deckRow = () => (fakeDb.canvas_deck ?? []).find((r) => r.id === DECK_ID);

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  currentUser = null;
  isAdminResult = false;
  vi.clearAllMocks();
});

describe("setDeckAgentFastLane authorization", () => {
  it("rejects a non-creator editor and writes nothing", async () => {
    seedDeck(CREATOR);
    currentUser = { id: EDITOR };
    isAdminResult = false; // an editor is not a workspace admin/owner

    const res = await setDeckAgentFastLane(DECK_ID, true);
    expect(res).toEqual({ ok: false, error: "not_authorized" });
    expect(deckRow()?.agent_fast_lane_enabled).toBe(false);
  });

  it("allows the deck creator", async () => {
    seedDeck(CREATOR);
    currentUser = { id: CREATOR };
    isAdminResult = false; // creator path never consults the RPC

    const res = await setDeckAgentFastLane(DECK_ID, true);
    expect(res).toEqual({ ok: true });
    expect(deckRow()?.agent_fast_lane_enabled).toBe(true);
  });

  it("allows a workspace admin/owner who is not the creator", async () => {
    seedDeck(CREATOR);
    currentUser = { id: ADMIN };
    isAdminResult = true;

    const res = await setDeckAgentFastLane(DECK_ID, true);
    expect(res).toEqual({ ok: true });
    expect(deckRow()?.agent_fast_lane_enabled).toBe(true);
  });
});
