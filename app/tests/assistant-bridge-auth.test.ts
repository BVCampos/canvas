// Unit tests for the in-app assistant bridge token resolver (ADR-0006).
//
// resolveBridgeToken is the single auth gate every bridge endpoint runs before
// it touches a row: it maps an MCP token to (user_id, workspace_id) through the
// service-role admin client, rejecting missing / unknown / revoked tokens and
// tokens whose workspace membership has since been removed. These tests pin all
// four BridgeAuth shapes (plus the two lookup-error branches) against an
// in-memory admin stub seeded per case — proving the discriminated outcome, not
// just that the call returns.

import { afterEach, describe, expect, it, vi } from "vitest";

// The resolver builds its own admin client via createAdminClient(); the mock
// reads from `fakeDb` so each test seeds exactly the rows it needs.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSupabase,
}));

import { resolveBridgeToken } from "../src/lib/canvas/assistant/bridge-auth";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

// Per-table forced errors: set fakeErr["workspace_memberships"] to make that
// table's lookup return an error, exercising the *_lookup_failed branches.
const fakeErr: Record<string, { message: string } | null> = {};

type Filter = { column: string; value: unknown };

// Minimal builder covering only what resolveBridgeToken uses: .select(...).eq().
// eq().maybeSingle(). It returns the first row matching every eq() filter, or a
// seeded error for the table.
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

  async maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const err = fakeErr[this.table];
    if (err) return { data: null, error: err };
    const rows = (fakeDb[this.table] ?? []).filter((row) =>
      this.filters.every((f) => row[f.column] === f.value),
    );
    return { data: rows[0] ?? null, error: null };
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
};

function resetDb() {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  for (const key of Object.keys(fakeErr)) delete fakeErr[key];
}

const TOKEN = "tok_live_aaaaaaaaaaaaaaaa";
const USER_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000b2";

function seedValidToken() {
  fakeDb.canvas_mcp_token = [
    { token: TOKEN, user_id: USER_ID, workspace_id: WORKSPACE_ID, revoked_at: null },
  ];
  fakeDb.workspace_memberships = [
    { user_id: USER_ID, workspace_id: WORKSPACE_ID },
  ];
}

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe("resolveBridgeToken", () => {
  it("rejects a null token with missing_token / 400 (no DB lookup)", async () => {
    const spy = vi.spyOn(mockSupabase, "from");
    const auth = await resolveBridgeToken(null);
    expect(auth).toEqual({ ok: false, status: 400, reason: "missing_token" });
    // Short-circuits before ever querying — a missing token is a client bug,
    // not a DB miss.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects an empty-string token with missing_token / 400", async () => {
    const auth = await resolveBridgeToken("");
    expect(auth).toEqual({ ok: false, status: 400, reason: "missing_token" });
  });

  it("rejects an unknown token with invalid_token / 401", async () => {
    // canvas_mcp_token is empty → no row → invalid.
    fakeDb.canvas_mcp_token = [];
    const auth = await resolveBridgeToken("tok_does_not_exist");
    expect(auth).toEqual({ ok: false, status: 401, reason: "invalid_token" });
  });

  it("rejects a revoked token with invalid_token / 401 even though the row exists", async () => {
    fakeDb.canvas_mcp_token = [
      {
        token: TOKEN,
        user_id: USER_ID,
        workspace_id: WORKSPACE_ID,
        revoked_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    fakeDb.workspace_memberships = [{ user_id: USER_ID, workspace_id: WORKSPACE_ID }];
    const auth = await resolveBridgeToken(TOKEN);
    // A live membership must NOT rescue a revoked token.
    expect(auth).toEqual({ ok: false, status: 401, reason: "invalid_token" });
  });

  it("rejects a valid token whose workspace membership is gone with membership_gone / 401", async () => {
    fakeDb.canvas_mcp_token = [
      { token: TOKEN, user_id: USER_ID, workspace_id: WORKSPACE_ID, revoked_at: null },
    ];
    fakeDb.workspace_memberships = []; // membership revoked since the token was minted
    const auth = await resolveBridgeToken(TOKEN);
    expect(auth).toEqual({ ok: false, status: 401, reason: "membership_gone" });
  });

  it("resolves a valid token + membership to the seeded user/workspace ids", async () => {
    seedValidToken();
    const auth = await resolveBridgeToken(TOKEN);
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("unreachable");
    expect(auth.userId).toBe(USER_ID);
    expect(auth.workspaceId).toBe(WORKSPACE_ID);
    // The success branch hands back a usable admin client.
    expect(auth.admin).toBe(mockSupabase);
  });

  it("surfaces a token-lookup DB error as lookup_failed / 500", async () => {
    fakeErr.canvas_mcp_token = { message: "connection reset" };
    const auth = await resolveBridgeToken(TOKEN);
    expect(auth).toEqual({ ok: false, status: 500, reason: "lookup_failed" });
  });

  it("surfaces a membership-lookup DB error as membership_lookup_failed / 500", async () => {
    fakeDb.canvas_mcp_token = [
      { token: TOKEN, user_id: USER_ID, workspace_id: WORKSPACE_ID, revoked_at: null },
    ];
    fakeErr.workspace_memberships = { message: "timeout" };
    const auth = await resolveBridgeToken(TOKEN);
    expect(auth).toEqual({ ok: false, status: 500, reason: "membership_lookup_failed" });
  });
});
