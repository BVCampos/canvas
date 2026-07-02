// Server-action test for updateDisplayNameAction — the /settings/account
// profile rename. The name lives in two stores that must stay in sync:
// auth.users.user_metadata (Topbar reads it off the session) and
// public.users.name (members lists / comments join it). The action must
// validate input before touching either, and an auth-metadata failure must
// short-circuit so the mirrored row never diverges from auth. Mocked over
// one in-memory store, mirroring set-deck-fast-lane-action.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-0000-0000-0000000000u1";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};
let currentUser: { id: string } | null = null;
let authUpdateError: { code?: string; message: string } | null = null;
let authMetadata: Record<string, unknown> = {};

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
  auth: {
    getUser: async () => ({ data: { user: currentUser }, error: null }),
    updateUser: async ({ data }: { data: Record<string, unknown> }) => {
      if (authUpdateError) return { data: null, error: authUpdateError };
      Object.assign(authMetadata, data);
      return { data: { user: currentUser }, error: null };
    },
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mockSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockSupabase }));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateDisplayNameAction } from "../src/lib/auth/actions";

function form(name: string | null): FormData {
  const fd = new FormData();
  if (name !== null) fd.set("name", name);
  return fd;
}

function seedProfile(name: string | null) {
  fakeDb.users = [{ id: USER, name }];
}
const profileRow = () => (fakeDb.users ?? []).find((r) => r.id === USER);

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  currentUser = null;
  authUpdateError = null;
  authMetadata = {};
  vi.clearAllMocks();
});

describe("updateDisplayNameAction", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await updateDisplayNameAction(form("Bernardo"));
    expect(res).toEqual({ ok: false, error: "not_authenticated" });
  });

  it("rejects an empty name without writing", async () => {
    seedProfile("Old Name");
    currentUser = { id: USER };

    const res = await updateDisplayNameAction(form("   "));
    expect(res).toEqual({ ok: false, error: "name_required" });
    expect(profileRow()?.name).toBe("Old Name");
    expect(authMetadata.name).toBeUndefined();
  });

  it("rejects a name over 60 characters without writing", async () => {
    seedProfile("Old Name");
    currentUser = { id: USER };

    const res = await updateDisplayNameAction(form("x".repeat(61)));
    expect(res).toEqual({ ok: false, error: "name_too_long" });
    expect(profileRow()?.name).toBe("Old Name");
  });

  it("updates auth metadata and the mirrored public.users row", async () => {
    seedProfile("Old Name");
    currentUser = { id: USER };

    const res = await updateDisplayNameAction(form("  New Name  "));
    expect(res).toEqual({ ok: true });
    // Trimmed once, written identically to both stores.
    expect(authMetadata.name).toBe("New Name");
    expect(profileRow()?.name).toBe("New Name");
  });

  it("does not touch public.users when the auth update fails", async () => {
    seedProfile("Old Name");
    currentUser = { id: USER };
    authUpdateError = { code: "500", message: "auth down" };

    const res = await updateDisplayNameAction(form("New Name"));
    expect(res).toEqual({ ok: false, error: "auth down" });
    expect(profileRow()?.name).toBe("Old Name");
  });
});
