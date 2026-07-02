// Ownership-gate test for the assistant bridge event route (ADR-0006).
//
// Every bridge event re-checks the referenced row against the token's user via
// ownRow() before mutating it. A token resolving to user A must NOT be able to
// touch a canvas_assistant_message owned by user B — and crucially the gate must
// block the WRITE, not merely return 404. This drives the route's POST with A's
// token at B's row and asserts (a) 404 not_found AND (b) zero updates landed on
// B's row (its content is untouched).

import { afterEach, describe, expect, it, vi } from "vitest";

// Resolve the bridge token straight to our stub admin client as user A, so the
// route's ownership check is the only gate under test.
const ADMIN_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE = "00000000-0000-0000-0000-0000000000ff";

vi.mock("@/lib/canvas/assistant/bridge-auth", async (importOriginal) => ({
  // Keep the real extractBridgeToken (pure header/query reader); only the
  // network-touching resolveBridgeToken is stubbed below.
  ...(await importOriginal()),
  resolveBridgeToken: vi.fn(async () => ({
    ok: true,
    admin: mockSupabase,
    userId: ADMIN_A,
    workspaceId: WORKSPACE,
  })),
}));

import { POST } from "../src/app/api/assistant/bridge/event/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

// Counts every .update() the route attempts, regardless of whether it matched
// rows — so we can prove the ownership gate short-circuits BEFORE any write.
let updateAttempts = 0;

type Filter = { column: string; value: unknown };

class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
  private op: "select" | "update" | "insert" = "select";
  private updateValues: Row = {};
  private insertRows: Row[] = [];

  constructor(table: string) {
    this.table = table;
  }

  select(_columns?: string) {
    void _columns;
    return this;
  }

  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(values: Row) {
    this.op = "update";
    this.updateValues = values;
    updateAttempts += 1;
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

  async single(): Promise<{ data: Row | null; error: null }> {
    // Only the start handler uses .single() on insert; not exercised here, but
    // kept realistic.
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "insert") {
      const inserted = this.insertRows.map((r, i) => ({
        id: `ins-${i}`,
        ...r,
      }));
      table.push(...inserted);
      return { data: inserted[0] ?? null, error: null };
    }
    const rows = table.filter((r) => this.matchRow(r));
    return { data: rows[0] ?? null, error: null };
  }

  // The update path ends in .eq() and is awaited directly (no .select()).
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
    if (this.op === "insert") {
      table.push(...this.insertRows);
      return { data: this.insertRows, error: null };
    }
    return { data: table.filter((r) => this.matchRow(r)), error: null };
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
};

// Build a NextRequest-shaped stub: the route reads `nextUrl.searchParams`,
// `headers.get("content-length")` (body-size guard), and `request.json()`.
function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    nextUrl: { searchParams: new URLSearchParams({ token: "tok_user_a" }) },
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  updateAttempts = 0;
  vi.clearAllMocks();
});

describe("event route — cross-tenant ownership gate", () => {
  const B_ROW_ID = "msg-bbbb-0000-0000-0000-000000000001";

  function seedBsRow() {
    fakeDb.canvas_assistant_message = [
      {
        id: B_ROW_ID,
        deck_id: "deck-b",
        workspace_id: WORKSPACE,
        user_id: USER_B, // owned by B, NOT by the token's user (A)
        role: "assistant",
        content: "B's private answer",
        status: "streaming",
      },
    ];
  }

  it("blocks a delta against another user's row: 404 AND no write lands", async () => {
    seedBsRow();
    const res = await POST(
      makeRequest({
        type: "delta",
        assistant_message_id: B_ROW_ID,
        content: "A trying to overwrite B",
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });

    // The gate must stop BEFORE the update — prove no .update() was attempted
    // and B's row content is byte-for-byte unchanged.
    expect(updateAttempts).toBe(0);
    const row = fakeDb.canvas_assistant_message.find((r) => r.id === B_ROW_ID);
    expect(row?.content).toBe("B's private answer");
    expect(row?.status).toBe("streaming");
  });

  it("blocks a finish against another user's row: 404 AND no status flip", async () => {
    seedBsRow();
    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: B_ROW_ID,
        user_message_id: B_ROW_ID,
        content: "forced completion",
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    expect(updateAttempts).toBe(0);
    const row = fakeDb.canvas_assistant_message.find((r) => r.id === B_ROW_ID);
    // Still streaming, still B's content — the finish never applied.
    expect(row?.status).toBe("streaming");
    expect(row?.content).toBe("B's private answer");
  });

  it("lets the token's own user write (control): a delta on A's row updates content", async () => {
    const A_ROW_ID = "msg-aaaa-0000-0000-0000-000000000002";
    fakeDb.canvas_assistant_message = [
      {
        id: A_ROW_ID,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: ADMIN_A,
        role: "assistant",
        content: "",
        status: "streaming",
      },
    ];

    const res = await POST(
      makeRequest({ type: "delta", assistant_message_id: A_ROW_ID, content: "hello from A" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The ownership gate passed, so exactly the owner's row was written.
    expect(updateAttempts).toBe(1);
    const row = fakeDb.canvas_assistant_message.find((r) => r.id === A_ROW_ID);
    expect(row?.content).toBe("hello from A");
  });
});
