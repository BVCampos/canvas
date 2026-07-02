// Reaper + guard tests for the assistant bridge poll route (ADR-0006 / ADR-0007).
//
// The headline fix this suite locks in is I2: reapStaleTurns scopes its
// "is there a fresh paired assistant row?" probe to the stuck prompt's
// THREAD, not its deck. Post-ADR-0007 a deck holds many threads, so a
// deck-scoped probe would see a sibling thread's fresh row and never reap a
// genuinely-dead prompt — the chatbox would hang "working…" forever. We drive
// two threads on one deck and assert the dead thread's prompt IS reaped while a
// fresh sibling thread does NOT mask it.
//
// Also covers: the streaming-row reaper, the no-false-reap control (a stale
// running prompt WITH a fresh paired assistant row in the same thread is left
// alone), the auth-fail short-circuit, and the rate-limit 429.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b2";

let authResult: unknown = {
  ok: true,
  admin: null as unknown,
  userId: USER_ID,
  workspaceId: WORKSPACE,
};

// rateLimitOk is mocked at the module boundary so a single test can force the
// 429 path; default lets every poll through.
let rateAllowed = true;

vi.mock("@/lib/canvas/assistant/bridge-auth", async (importOriginal) => ({
  // Keep the real extractBridgeToken (pure header/query reader); only the
  // network-touching resolveBridgeToken is stubbed below.
  ...(await importOriginal()),
  resolveBridgeToken: vi.fn(async () => authResult),
}));
vi.mock("@/lib/canvas/rate-limit", () => ({
  rateLimitOk: vi.fn(async () => rateAllowed),
}));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { POST } from "../src/app/api/assistant/bridge/poll/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

let updateAttempts = 0;

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "lt"; column: string; value: string }
  | { kind: "gte"; column: string; value: string }
  | { kind: "not_is"; column: string };

// Same chainable builder as the other poll suites (eq/in/lt/gte/not, order,
// limit, single/maybeSingle, upsert no-op, awaitable update), with an
// updateAttempts counter so we can prove the auth/rate gates write nothing.
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
    updateAttempts += 1;
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

// STALE_MS in the route is 120_000. "stale" = older than the cutoff; "fresh" =
// well within the window. We seed absolute ISO timestamps so the route's
// Date.now()-based cutoff classifies them deterministically.
const STALE_MS = 120_000;
function staleIso() {
  return new Date(Date.now() - STALE_MS - 60_000).toISOString(); // ~3min ago
}
function freshIso() {
  return new Date(Date.now() - 1_000).toISOString(); // 1s ago
}

function resetAuthOk() {
  authResult = { ok: true, admin: mockSupabase, userId: USER_ID, workspaceId: WORKSPACE };
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  updateAttempts = 0;
  rateAllowed = true;
  resetAuthOk();
  vi.clearAllMocks();
});

resetAuthOk();

describe("poll route — reapStaleTurns thread-scoping (I2)", () => {
  it("a dead prompt in thread A is reaped even though sibling thread B has a fresh row", async () => {
    // One deck, two threads of the same user.
    //   Thread A: a 'running' user prompt older than the cutoff, NO fresh
    //             assistant row -> genuinely dead, must be reaped to error.
    //   Thread B: a freshly-updated 'streaming' assistant row -> a live sibling.
    // Pre-I2 the freshness probe was deck-scoped, so thread B's fresh row would
    // mask thread A's dead prompt and it would hang forever. Thread-scoped, A
    // is reaped and B is left alone.
    fakeDb.canvas_assistant_message = [
      {
        id: "promptA",
        deck_id: "deck-1",
        thread_id: "thread-A",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "running",
        content: "edit A",
        created_at: staleIso(),
        updated_at: staleIso(),
      },
      {
        id: "asstB",
        deck_id: "deck-1",
        thread_id: "thread-B",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "assistant",
        status: "streaming",
        content: "B is live",
        created_at: freshIso(),
        updated_at: freshIso(),
      },
    ];

    await POST(makeRequest());

    const promptA = fakeDb.canvas_assistant_message.find((r) => r.id === "promptA");
    // The dead prompt in thread A was reaped despite thread B's fresh sibling.
    expect(promptA?.status).toBe("error");
    expect(promptA?.error).toMatch(/stopped responding/i);

    // Thread B's fresh assistant row is untouched (it's recent, not stale).
    const asstB = fakeDb.canvas_assistant_message.find((r) => r.id === "asstB");
    expect(asstB?.status).toBe("streaming");
    expect(asstB?.content).toBe("B is live");
  });

  it("control: a stale running prompt WITH a fresh paired assistant row in the SAME thread is NOT reaped", async () => {
    // The same-thread fresh assistant row means a live (or just-finished) turn —
    // reaping here would be a false positive on a long-running turn.
    fakeDb.canvas_assistant_message = [
      {
        id: "promptLive",
        deck_id: "deck-2",
        thread_id: "thread-live",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "running",
        content: "a long edit",
        created_at: staleIso(),
        updated_at: staleIso(),
      },
      {
        id: "asstLive",
        deck_id: "deck-2",
        thread_id: "thread-live", // SAME thread as the prompt
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "assistant",
        status: "streaming",
        content: "still working",
        created_at: freshIso(),
        updated_at: freshIso(),
      },
    ];

    await POST(makeRequest());

    const prompt = fakeDb.canvas_assistant_message.find((r) => r.id === "promptLive");
    // Left alone — its own thread has a fresh assistant row.
    expect(prompt?.status).toBe("running");
    expect(prompt?.error).toBeUndefined();
  });

  it("a streaming assistant row older than the cutoff is flipped to error", async () => {
    fakeDb.canvas_assistant_message = [
      {
        id: "deadStream",
        deck_id: "deck-3",
        thread_id: "thread-3",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "assistant",
        status: "streaming",
        content: "half a sentence",
        created_at: staleIso(),
        updated_at: staleIso(),
      },
    ];

    await POST(makeRequest());

    const row = fakeDb.canvas_assistant_message.find((r) => r.id === "deadStream");
    expect(row?.status).toBe("error");
    expect(row?.error).toMatch(/stopped responding/i);
  });

  it("a fresh streaming assistant row is NOT reaped (cutoff lower bound)", async () => {
    fakeDb.canvas_assistant_message = [
      {
        id: "liveStream",
        deck_id: "deck-4",
        thread_id: "thread-4",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "assistant",
        status: "streaming",
        content: "currently typing",
        created_at: freshIso(),
        updated_at: freshIso(),
      },
    ];

    await POST(makeRequest());

    const row = fakeDb.canvas_assistant_message.find((r) => r.id === "liveStream");
    expect(row?.status).toBe("streaming");
  });
});

describe("poll route — auth + rate-limit gates", () => {
  it("a 401 from resolveBridgeToken returns 401 and writes/claims nothing", async () => {
    authResult = { ok: false, status: 401, reason: "invalid_token" };
    // Seed a queued prompt that WOULD be claimed if the gate didn't fire.
    fakeDb.canvas_assistant_message = [
      {
        id: "q1",
        deck_id: "deck-5",
        thread_id: "thread-5",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "queued",
        content: "claim me",
        created_at: freshIso(),
        updated_at: freshIso(),
      },
    ];

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_token" });
    // No claim/reaper write ran, and the prompt is still queued.
    expect(updateAttempts).toBe(0);
    const q1 = fakeDb.canvas_assistant_message.find((r) => r.id === "q1");
    expect(q1?.status).toBe("queued");
  });

  it("rate-limit: rateLimitOk=false returns 429 and claims nothing", async () => {
    rateAllowed = false;
    fakeDb.canvas_assistant_message = [
      {
        id: "q2",
        deck_id: "deck-6",
        thread_id: "thread-6",
        workspace_id: WORKSPACE,
        user_id: USER_ID,
        role: "user",
        status: "queued",
        content: "claim me too",
        created_at: freshIso(),
        updated_at: freshIso(),
      },
    ];

    const res = await POST(makeRequest());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
    // Tripped before the reaper/claim — nothing written, prompt still queued.
    expect(updateAttempts).toBe(0);
    const q2 = fakeDb.canvas_assistant_message.find((r) => r.id === "q2");
    expect(q2?.status).toBe("queued");
  });
});
