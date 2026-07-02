// Reaper TOCTOU-guard test for the assistant bridge poll route (ADR-0006 / 0007).
//
// reapStaleTurns selects stuck 'running' user prompts, then for each one (whose
// thread has no fresh assistant row) flips it to 'error'. Between the select and
// that terminal UPDATE there is a TOCTOU window: a concurrent handleFinish can
// flip the very same prompt to 'complete'. The fix scopes the terminal UPDATE
// with `.eq("status","running")` so it can ONLY touch a row that is STILL
// running — a row that has already moved to 'complete' must be left untouched
// and never clobbered back to 'error'.
//
// This is the sibling of assistant-reaper.test.ts (which covers thread-scoping,
// the stream reaper, and the auth/rate gates). Here the QueryBuilder is extended
// so the stuck-prompt SELECT returns a row whose LIVE status in the store is
// already 'complete' — exactly the race the guard defends against. With the
// `.eq("status","running")` predicate the complete row is excluded and stays
// complete; drop the predicate and the id-only UPDATE clobbers it to 'error' and
// this test fails. We assert the terminal UPDATE both carries the
// `status = running` predicate AND leaves the completed row intact.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b2";

let authResult: unknown = {
  ok: true,
  admin: null as unknown,
  userId: USER_ID,
  workspaceId: WORKSPACE,
};

vi.mock("@/lib/canvas/assistant/bridge-auth", async (importOriginal) => ({
  // Keep the real extractBridgeToken (pure header/query reader); only the
  // network-touching resolveBridgeToken is stubbed below.
  ...(await importOriginal()),
  resolveBridgeToken: vi.fn(async () => authResult),
}));
vi.mock("@/lib/canvas/rate-limit", () => ({
  rateLimitOk: vi.fn(async () => true),
}));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { POST } from "../src/app/api/assistant/bridge/poll/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

// Records every terminal reaper UPDATE so we can inspect its predicates. Each
// entry captures the values written and the filter chain that was applied.
type UpdateLog = {
  table: string;
  values: Row;
  filters: Filter[];
};
const updateLog: UpdateLog[] = [];

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "lt"; column: string; value: string }
  | { kind: "gte"; column: string; value: string }
  | { kind: "not_is"; column: string };

// Same chainable builder shape as assistant-reaper.test.ts, with two additions:
//   (1) an updateLog so we can assert the terminal UPDATE's predicate set, and
//   (2) a per-test "select override" hook so the stuck-prompt SELECT can hand
//       back a row whose live status is no longer 'running' (the TOCTOU race).
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

  private isStuckUserSelect(): boolean {
    // The stuck-prompt probe: select on canvas_assistant_message filtered by
    // role=user AND status=running (see reapStaleTurns step 2).
    if (this.table !== "canvas_assistant_message" || this.op !== "select") return false;
    const has = (column: string, value: unknown) =>
      this.filters.some((f) => f.kind === "eq" && f.column === column && f.value === value);
    return has("role", "user") && has("status", "running");
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

    // Simulate the TOCTOU: the stuck-prompt SELECT runs FIRST and sees every
    // matching row as 'running' (it returns the real matches by predicate). We
    // then flip ONLY the rows flagged __wasStuck to 'complete' (as a concurrent
    // handleFinish would) BEFORE the route issues its terminal UPDATE — so those
    // ids are no longer running by the time the UPDATE lands, while unflagged
    // stale-running rows stay running and are reaped normally.
    if (this.isStuckUserSelect()) {
      const matches = table.filter((row) => this.matchRow(row));
      const stuck = matches.map((row) => ({ id: row.id, thread_id: row.thread_id }));
      // The race: settle the flagged prompts 'complete' now, before the UPDATE.
      for (const row of matches) {
        if (row.__wasStuck === true) row.status = "complete";
      }
      return { data: stuck, error: null };
    }

    if (this.op === "update") {
      updateLog.push({
        table: this.table,
        values: { ...this.updateValues },
        filters: [...this.filters],
      });
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

const STALE_MS = 120_000;
function staleIso() {
  return new Date(Date.now() - STALE_MS - 60_000).toISOString();
}

function resetAuthOk() {
  authResult = { ok: true, admin: mockSupabase, userId: USER_ID, workspaceId: WORKSPACE };
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  updateLog.length = 0;
  resetAuthOk();
  vi.clearAllMocks();
});

resetAuthOk();

describe("poll route — reaper terminal UPDATE is status-guarded (TOCTOU)", () => {
  it("a prompt that became 'complete' after selection is NOT clobbered to 'error'", async () => {
    // The prompt looked stuck ('running', stale, no fresh assistant row in its
    // thread), so it lands in the reaper's stuck set. But before the terminal
    // UPDATE runs, a concurrent finish moves it to 'complete' (the harness flips
    // it inside the stuck-prompt SELECT). The `.eq("status","running")` predicate
    // on the terminal UPDATE must exclude it so it stays 'complete'.
    fakeDb.canvas_assistant_message = [
      {
        id: "promptRacing",
        deck_id: "deck-1",
        thread_id: "thread-racing",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "running",
        content: "edit that actually finished",
        created_at: staleIso(),
        updated_at: staleIso(),
        __wasStuck: true, // marks it as the stuck row the SELECT returns
      },
    ];

    await POST(makeRequest());

    // The completed prompt survived the reaper — it was NOT flipped to error.
    const prompt = fakeDb.canvas_assistant_message.find((r) => r.id === "promptRacing");
    expect(prompt?.status).toBe("complete");
    expect(prompt?.error).toBeUndefined();

    // Structural assertion: the reaper's terminal UPDATE (the one that writes
    // status:error onto a single prompt id) carries a `status = running`
    // predicate. This is the load-bearing guard; without it the id-only UPDATE
    // would have clobbered the completed row above.
    const terminalReap = updateLog.find(
      (u) =>
        u.table === "canvas_assistant_message" &&
        u.values.status === "error" &&
        u.filters.some((f) => f.kind === "eq" && f.column === "id"),
    );
    expect(terminalReap).toBeTruthy();
    expect(
      terminalReap?.filters.some(
        (f) => f.kind === "eq" && f.column === "status" && f.value === "running",
      ),
    ).toBe(true);
  });

  it("control: a genuinely-still-running stuck prompt IS reaped to error", async () => {
    // Same shape, but no concurrent finish: the row stays 'running' through the
    // terminal UPDATE, so the `status = running` predicate matches and it is
    // reaped. Proves the guard doesn't over-block real dead prompts.
    fakeDb.canvas_assistant_message = [
      {
        id: "promptDead",
        deck_id: "deck-2",
        thread_id: "thread-dead",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "running",
        content: "edit that never finished",
        created_at: staleIso(),
        updated_at: staleIso(),
        // NOT __wasStuck — the normal SELECT path returns it and it stays running.
      },
    ];

    await POST(makeRequest());

    const prompt = fakeDb.canvas_assistant_message.find((r) => r.id === "promptDead");
    expect(prompt?.status).toBe("error");
    expect(prompt?.error).toMatch(/stopped responding/i);
  });
});
