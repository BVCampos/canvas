// Tests for the assistant bridge cancel-check route (ADR-0008).
//
// While a turn runs, the bridge polls this read-only endpoint to learn if the
// user hit Stop. It must (a) report canceled=true only when the OWNED prompt row
// has cancel_requested_at set, (b) fail closed for a foreign/missing row (read as
// "not canceled", never leaking existence), and (c) reject a missing id. The
// token→user resolve and the rate limiter are stubbed so the ownership +
// flag-read logic is the only thing under test.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE = "00000000-0000-0000-0000-0000000000ff";

vi.mock("@/lib/canvas/assistant/bridge-auth", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveBridgeToken: vi.fn(async () => ({
    ok: true,
    admin: mockSupabase,
    userId: USER_A,
    workspaceId: WORKSPACE,
  })),
}));
// The limiter calls admin.rpc; short-circuit it to "allowed" so it never gates.
vi.mock("@/lib/canvas/rate-limit", () => ({ rateLimitOk: async () => true }));

import { POST } from "../src/app/api/assistant/bridge/cancel-check/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

type Filter = { column: string; value: unknown };

class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];

  constructor(table: string) {
    this.table = table;
  }
  select(_columns?: string) {
    void _columns;
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
}

const mockSupabase = { from: (table: string) => new QueryBuilder(table) };

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    nextUrl: { searchParams: new URLSearchParams({ token: "tok_a" }) },
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  vi.clearAllMocks();
});

const OWNED = "msg-aaaa-0000-0000-0000-000000000001";

describe("cancel-check route", () => {
  it("reports canceled=true when the owned row has cancel_requested_at set", async () => {
    fakeDb.canvas_assistant_message = [
      { id: OWNED, user_id: USER_A, cancel_requested_at: new Date().toISOString() },
    ];
    const res = await POST(makeRequest({ user_message_id: OWNED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, canceled: true });
  });

  it("reports canceled=false when no stop is pending on the owned row", async () => {
    fakeDb.canvas_assistant_message = [
      { id: OWNED, user_id: USER_A, cancel_requested_at: null },
    ];
    const res = await POST(makeRequest({ user_message_id: OWNED }));
    expect(await res.json()).toEqual({ ok: true, canceled: false });
  });

  it("fails closed for another user's row even if it has a stop pending", async () => {
    fakeDb.canvas_assistant_message = [
      { id: OWNED, user_id: USER_B, cancel_requested_at: new Date().toISOString() },
    ];
    const res = await POST(makeRequest({ user_message_id: OWNED }));
    // Ownership mismatch → never reports another user's stop.
    expect(await res.json()).toEqual({ ok: true, canceled: false });
  });

  it("reports canceled=false for a missing row", async () => {
    const res = await POST(makeRequest({ user_message_id: "nope" }));
    expect(await res.json()).toEqual({ ok: true, canceled: false });
  });

  it("rejects a missing user_message_id with 400 bad_field", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "bad_field" });
  });
});
