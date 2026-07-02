// Thread-scoped resume test for the assistant bridge poll route (ADR-0007).
//
// Since threads, the Agent SDK session id lives on canvas_assistant_thread, not
// on the latest assistant message. The poll route claims a queued prompt, reads
// its thread_id, and looks the resume pointer up on THAT thread — so two
// threads of the same (deck, user) resume independently. This drives the route
// against an in-memory store and asserts each claimed prompt comes back with its
// own thread's session id (and its thread_id), not some deck-wide latest.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b2";

vi.mock("@/lib/canvas/assistant/bridge-auth", async (importOriginal) => ({
  // Keep the real extractBridgeToken (pure header/query reader); only the
  // network-touching resolveBridgeToken is stubbed below.
  ...(await importOriginal()),
  resolveBridgeToken: vi.fn(async () => ({
    ok: true,
    admin: mockSupabase,
    userId: USER_ID,
    workspaceId: WORKSPACE,
  })),
}));

import { POST } from "../src/app/api/assistant/bridge/poll/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "lt"; column: string; value: string }
  | { kind: "gte"; column: string; value: string }
  | { kind: "not_is"; column: string };

// Same chainable builder shape as assistant-poll-claim.test.ts: select/update,
// eq/in/lt/gte/not, order/limit, single/maybeSingle, awaitable update.
class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
  private op: "select" | "update" = "select";
  private updateValues: Row = {};
  private orderColumn: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

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
  // Presence heartbeat (0044): the poll route fires a best-effort upsert and
  // only reads {error}. No-op that resolves cleanly — never touches the queue.
  upsert(_values: Row, _opts?: { onConflict?: string }) {
    void _values;
    void _opts;
    return Promise.resolve({ data: null, error: null });
  }
  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ kind: "in", column, values });
    return this;
  }
  lt(column: string, value: string) {
    this.filters.push({ kind: "lt", column, value });
    return this;
  }
  gte(column: string, value: string) {
    this.filters.push({ kind: "gte", column, value });
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== "is" || value !== null) {
      throw new Error(`QueryBuilder.not: unsupported ${operator}/${String(value)}`);
    }
    this.filters.push({ kind: "not_is", column });
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.orderColumn = column;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  single() {
    return this.execute().then((r) => ({ data: r.data[0] ?? null, error: null }));
  }
  maybeSingle() {
    return this.execute().then((r) => ({ data: r.data[0] ?? null, error: null }));
  }
  then<T>(onFulfilled?: (value: { data: Row[]; error: null }) => T): Promise<T> {
    return this.execute().then(onFulfilled as (v: { data: Row[]; error: null }) => T);
  }

  private matchRow(row: Row): boolean {
    for (const f of this.filters) {
      const value =
        f.column === "execution_runtime"
          ? (row[f.column] ?? "bridge")
          : row[f.column];
      if (f.kind === "eq" && value !== f.value) return false;
      if (f.kind === "in" && !f.values.includes(row[f.column])) return false;
      if (f.kind === "lt" && !(String(row[f.column]) < f.value)) return false;
      if (f.kind === "gte" && !(String(row[f.column]) >= f.value)) return false;
      if (f.kind === "not_is" && (row[f.column] === null || row[f.column] === undefined))
        return false;
    }
    return true;
  }

  private async execute(): Promise<{ data: Row[]; error: null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "update") {
      const matches = table.filter((row) => this.matchRow(row));
      for (const row of matches) Object.assign(row, this.updateValues);
      return { data: matches, error: null };
    }
    let rows = table.filter((row) => this.matchRow(row));
    if (this.orderColumn) {
      const col = this.orderColumn;
      const asc = this.orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        if (av === bv) return 0;
        return asc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return { data: rows, error: null };
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
  rpc: async () => ({ data: 1, error: null }),
};

function makeRequest(): Parameters<typeof POST>[0] {
  return {
    nextUrl: { searchParams: new URLSearchParams({ token: "tok_poll" }) },
    headers: new Headers(),
  } as unknown as Parameters<typeof POST>[0];
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  vi.clearAllMocks();
});

describe("poll route — per-thread session resume (ADR-0007)", () => {
  it("each claimed prompt resumes ITS thread's session, and carries thread_id", async () => {
    const now = Date.now();
    // Two threads on the SAME deck, each with its own session id.
    fakeDb.canvas_assistant_thread = [
      { id: "thread-A", deck_id: "deck-1", user_id: USER_ID, claude_session_id: "sess-A" },
      { id: "thread-B", deck_id: "deck-1", user_id: USER_ID, claude_session_id: "sess-B" },
    ];
    // One queued prompt in each thread.
    fakeDb.canvas_assistant_message = [
      {
        id: "msg-A",
        deck_id: "deck-1",
        thread_id: "thread-A",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "queued",
        content: "edit A",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      {
        id: "msg-B",
        deck_id: "deck-1",
        thread_id: "thread-B",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "queued",
        content: "edit B",
        created_at: new Date(now + 1).toISOString(),
        updated_at: new Date(now + 1).toISOString(),
      },
    ];

    const res = await POST(makeRequest());
    const body = (await res.json()) as {
      ok: boolean;
      messages: Array<{ id: string; thread_id: string; resume_session_id: string | null }>;
    };

    expect(body.ok).toBe(true);
    expect(body.messages).toHaveLength(2);

    const byId = Object.fromEntries(body.messages.map((m) => [m.id, m]));
    // Each prompt resumes its OWN thread's session — not a deck-wide latest.
    expect(byId["msg-A"].thread_id).toBe("thread-A");
    expect(byId["msg-A"].resume_session_id).toBe("sess-A");
    expect(byId["msg-B"].thread_id).toBe("thread-B");
    expect(byId["msg-B"].resume_session_id).toBe("sess-B");
  });

  it("a thread with no session yet resumes null (cold start)", async () => {
    const now = Date.now();
    fakeDb.canvas_assistant_thread = [
      { id: "thread-new", deck_id: "deck-9", user_id: USER_ID, claude_session_id: null },
    ];
    fakeDb.canvas_assistant_message = [
      {
        id: "msg-new",
        deck_id: "deck-9",
        thread_id: "thread-new",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "queued",
        content: "first ask",
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
    ];

    const res = await POST(makeRequest());
    const body = (await res.json()) as {
      messages: Array<{ id: string; thread_id: string; resume_session_id: string | null }>;
    };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].thread_id).toBe("thread-new");
    expect(body.messages[0].resume_session_id).toBeNull();
  });
});
