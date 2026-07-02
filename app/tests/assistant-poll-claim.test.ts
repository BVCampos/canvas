// Atomic-claim test for the assistant bridge poll route (ADR-0006).
//
// The poll route claims queued prompts with a conditional update:
//   .update({status:'running'}).in('id', ids).eq('status','queued').select(...)
// The `.eq('status','queued')` is the race guard: only rows STILL queued flip to
// running, so two bridges polling at once each claim a DISJOINT subset and no
// row is ever handed out twice. This drives two POSTs against ONE shared
// in-memory store whose conditional update enforces that exact semantics, and
// asserts the two claims partition the queue with no overlap.

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

// A chainable builder that supports the full surface the poll route exercises:
// select/update, eq/in/lt/gte/not, order/limit, single/maybeSingle, and the
// awaitable update path. The conditional claim — .update().in().eq().select() —
// mutates ONLY rows matching every filter at execution time, which is what makes
// the second racing claim come back empty for already-running rows.
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

  // Presence heartbeat (0044): the poll route fires a best-effort upsert on
  // canvas_assistant_bridge_presence and only reads {error}. Model it as a
  // no-op that resolves cleanly so it never touches the queue under test.
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
      if (f.kind === "not_is" && (row[f.column] === null || row[f.column] === undefined)) return false;
    }
    return true;
  }

  private async execute(): Promise<{ data: Row[]; error: null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);

    if (this.op === "update") {
      // Evaluate the predicate at execution time, then mutate the live rows.
      // The conditional claim relies on this: by the time the 2nd poll runs its
      // update, the rows the 1st claimed are already 'running', so they no
      // longer match `.eq('status','queued')` and aren't touched/returned.
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
  // rateLimitOk() calls admin.rpc(...) — return a positive count so the limiter
  // passes (it fails-open on `data !== false`).
  rpc: async () => ({ data: 1, error: null }),
};

// All `updated_at` timestamps are NOW, so reapStaleTurns (120s cutoff) finds
// nothing stale and leaves the queue intact for the claim under test.
function makeRequest(): Parameters<typeof POST>[0] {
  return {
    nextUrl: { searchParams: new URLSearchParams({ token: "tok_poll" }) },
    headers: new Headers(),
  } as unknown as Parameters<typeof POST>[0];
}

function seedQueue(n: number) {
  const now = new Date().toISOString();
  fakeDb.canvas_assistant_message = Array.from({ length: n }, (_, i) => ({
    id: `msg-${String(i).padStart(4, "0")}`,
    deck_id: `deck-${i}`,
    workspace_id: WORKSPACE,
    user_id: USER_ID,
    role: "user",
    status: "queued",
    content: `prompt ${i}`,
    created_at: new Date(Date.now() + i).toISOString(),
    updated_at: now,
  }));
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  vi.clearAllMocks();
});

describe("poll route — atomic claim", () => {
  it("two concurrent polls claim DISJOINT subsets, no row twice", async () => {
    // 8 queued prompts but MAX_CLAIM=5, so the first poll claims 5; a second
    // poll, running before any of those finish, must claim only what's left.
    seedQueue(8);

    // Poll A and poll B race. Awaiting sequentially still models the race we
    // care about: B's claim update runs AFTER A flipped its rows to 'running',
    // so the `.eq('status','queued')` guard excludes them — exactly the DB's
    // atomic behavior under a real concurrent claim.
    const resA = await POST(makeRequest());
    const resB = await POST(makeRequest());

    const bodyA = (await resA.json()) as { ok: boolean; messages: Array<{ id: string }> };
    const bodyB = (await resB.json()) as { ok: boolean; messages: Array<{ id: string }> };

    expect(bodyA.ok).toBe(true);
    expect(bodyB.ok).toBe(true);

    const idsA = bodyA.messages.map((m) => m.id);
    const idsB = bodyB.messages.map((m) => m.id);

    // First poll takes the MAX_CLAIM ceiling; second takes the remainder.
    expect(idsA).toHaveLength(5);
    expect(idsB).toHaveLength(3);

    // Disjoint: no id appears in both claims.
    const overlap = idsA.filter((id) => idsB.includes(id));
    expect(overlap).toEqual([]);

    // Together they cover all 8 exactly once.
    expect(new Set([...idsA, ...idsB]).size).toBe(8);

    // Every row is now 'running' — none left queued, none double-claimed.
    const statuses = fakeDb.canvas_assistant_message.map((r) => r.status);
    expect(statuses.every((s) => s === "running")).toBe(true);
  });

  it("a second poll over an already-claimed queue returns no rows", async () => {
    // Exactly MAX_CLAIM rows: the first poll claims all of them; a re-poll must
    // find nothing still queued and return an empty message list (the claim's
    // conditional update returns [] when no row matches `status='queued'`).
    seedQueue(5);

    const first = (await (await POST(makeRequest())).json()) as {
      messages: Array<{ id: string }>;
    };
    expect(first.messages).toHaveLength(5);

    const second = (await (await POST(makeRequest())).json()) as {
      ok: boolean;
      messages: Array<{ id: string }>;
    };
    expect(second.ok).toBe(true);
    expect(second.messages).toEqual([]);
  });

  it("never claims a queued OpenRouter turn", async () => {
    seedQueue(2);
    fakeDb.canvas_assistant_message.push({
      id: "msg-openrouter",
      deck_id: "deck-api",
      workspace_id: WORKSPACE,
      user_id: USER_ID,
      role: "user",
      status: "queued",
      execution_runtime: "openrouter",
      content: "server turn",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const body = (await (await POST(makeRequest())).json()) as {
      messages: Array<{ id: string }>;
    };
    expect(body.messages.map((message) => message.id)).not.toContain(
      "msg-openrouter",
    );
    expect(
      fakeDb.canvas_assistant_message.find(
        (row) => row.id === "msg-openrouter",
      )?.status,
    ).toBe("queued");
  });
});
