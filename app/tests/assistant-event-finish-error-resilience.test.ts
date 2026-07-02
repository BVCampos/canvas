// Resilience tests for the assistant bridge event route (ADR-0006 / 0007).
//
// Two post-fix behaviors that the existing lifecycle/ownership suites don't pin:
//
//   Behavior 2 — handleError 404 when nothing was owned/updated.
//     If neither the assistant_message_id nor the resolved user_message_id maps
//     to a row owned by the caller, handleError must return 404
//     { ok: false, error: "not_found" } (it previously returned { ok: true },
//     masking a misrouted/foreign error event). The happy path — an owned row
//     IS updated — must still return { ok: true }.
//
//   Behavior 3 — handleFinish survives a failing SECONDARY (user-row) write.
//     The ASSISTANT-row update is critical: a DB error there still 500s. But the
//     USER-row close-out is best-effort (like the session-pointer write): if it
//     errors it must be logged and the finish must still return { ok: true } —
//     the answer is already committed, so a failed prompt close-out must not
//     report the whole turn as failed.
//
// The QueryBuilder mirrors the lifecycle suite's (honors eq/neq, single/insert,
// awaitable update) but adds a per-UPDATE error injector keyed by table+id so a
// single test can fail exactly the user-row write while the assistant-row write
// succeeds.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE = "00000000-0000-0000-0000-0000000000ff";

let authResult: unknown = {
  ok: true,
  admin: null as unknown,
  userId: USER_A,
  workspaceId: WORKSPACE,
};

vi.mock("@/lib/canvas/assistant/bridge-auth", async (importOriginal) => ({
  // Keep the real extractBridgeToken (pure header/query reader); only the
  // network-touching resolveBridgeToken is stubbed below.
  ...(await importOriginal()),
  resolveBridgeToken: vi.fn(async () => authResult),
}));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { POST } from "../src/app/api/assistant/bridge/event/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

let insertAttempts = 0;
let updateAttempts = 0;
let insertSeq = 0;

// Per-UPDATE failure injector. When set, an UPDATE that matches table AND filters
// on `id === failOnUpdate.id` resolves with an error instead of writing. This is
// how a test fails ONLY the user-row close-out while the assistant-row update
// (which targets a different id) succeeds.
let failOnUpdate: { table: string; id: string } | null = null;

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown };

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
    insertAttempts += 1;
    return this;
  }

  update(values: Row) {
    this.op = "update";
    this.updateValues = values;
    updateAttempts += 1;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  private matchRow(row: Row): boolean {
    return this.filters.every((f) =>
      f.kind === "eq" ? row[f.column] === f.value : row[f.column] !== f.value,
    );
  }

  private targetsFailingId(): boolean {
    if (!failOnUpdate || this.table !== failOnUpdate.table) return false;
    return this.filters.some(
      (f) => f.kind === "eq" && f.column === "id" && f.value === failOnUpdate!.id,
    );
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = (fakeDb[this.table] ?? []).filter((r) => this.matchRow(r));
    return { data: rows[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "insert") {
      const inserted = this.insertRows.map((r) => ({ id: `ins-${insertSeq++}`, ...r }));
      table.push(...inserted);
      return { data: inserted[0] ?? null, error: null };
    }
    const rows = table.filter((r) => this.matchRow(r));
    return { data: rows[0] ?? null, error: null };
  }

  then<T>(onFulfilled?: (value: { data: Row[]; error: unknown }) => T): Promise<T> {
    return this.execute().then(onFulfilled as (v: { data: Row[]; error: unknown }) => T);
  }

  private async execute(): Promise<{ data: Row[]; error: unknown }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "update") {
      // Injected failure: report a DB error WITHOUT writing, so the route's
      // error branch for this specific write is exercised.
      if (this.targetsFailingId()) {
        return { data: [], error: { message: "injected update failure" } };
      }
      const matches = table.filter((r) => this.matchRow(r));
      for (const row of matches) Object.assign(row, this.updateValues);
      return { data: matches, error: null };
    }
    if (this.op === "insert") {
      const inserted = this.insertRows.map((r) => ({ id: `ins-${insertSeq++}`, ...r }));
      table.push(...inserted);
      return { data: inserted, error: null };
    }
    return { data: table.filter((r) => this.matchRow(r)), error: null };
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
};

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    nextUrl: { searchParams: new URLSearchParams({ token: "tok_user_a" }) },
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function resetAuthOk() {
  authResult = { ok: true, admin: mockSupabase, userId: USER_A, workspaceId: WORKSPACE };
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  insertAttempts = 0;
  updateAttempts = 0;
  insertSeq = 0;
  failOnUpdate = null;
  resetAuthOk();
  vi.clearAllMocks();
});

resetAuthOk();

const A_USER_MSG = "user-aaaa-0000-0000-0000-000000000001";
const A_ASSISTANT_MSG = "asst-aaaa-0000-0000-0000-000000000010";

describe("event route — handleError returns 404 when nothing is owned (Behavior 2)", () => {
  it("ids resolve to NO owned rows -> 404 not_found, zero writes", async () => {
    // A's token, but the referenced prompt + assistant rows are owned by B. Both
    // ownRow() calls return null, so neither branch writes anything. Post-fix the
    // handler must REPORT that nothing matched: 404 { ok:false, error:"not_found" }
    // instead of the old misleading { ok:true }.
    fakeDb.canvas_assistant_message = [
      {
        id: "user-bbbb-0000-0000-0000-000000000002",
        deck_id: "deck-b",
        workspace_id: WORKSPACE,
        user_id: USER_B,
        thread_id: "thread-b",
        role: "user",
        content: "B's prompt",
        status: "running",
      },
      {
        id: "asst-bbbb-0000-0000-0000-000000000003",
        deck_id: "deck-b",
        workspace_id: WORKSPACE,
        user_id: USER_B,
        thread_id: "thread-b",
        role: "assistant",
        content: "B's stream",
        status: "streaming",
      },
    ];

    const res = await POST(
      makeRequest({
        type: "error",
        user_message_id: "user-bbbb-0000-0000-0000-000000000002",
        assistant_message_id: "asst-bbbb-0000-0000-0000-000000000003",
        error: "A trying to error B's turn",
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    // Nothing was written or inserted — and B's rows are untouched.
    expect(updateAttempts).toBe(0);
    expect(insertAttempts).toBe(0);
    const asst = fakeDb.canvas_assistant_message.find(
      (r) => r.id === "asst-bbbb-0000-0000-0000-000000000003",
    );
    expect(asst?.status).toBe("streaming");
    expect(asst?.content).toBe("B's stream");
  });

  it("a totally unknown user_message_id (no assistant id) -> 404 not_found", async () => {
    // No assistant_message_id, and the user_message_id matches no row at all.
    // Both ownRow() return null, so there is nothing to error -> 404.
    fakeDb.canvas_assistant_message = [];

    const res = await POST(
      makeRequest({
        type: "error",
        user_message_id: "user-does-not-exist-0000-000000000099",
        error: "into the void",
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    expect(updateAttempts).toBe(0);
    expect(insertAttempts).toBe(0);
  });

  it("positive control: an owned assistant row IS updated -> { ok: true } (no regression)", async () => {
    fakeDb.canvas_assistant_message = [
      {
        id: A_USER_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "user",
        content: "prompt",
        status: "running",
      },
      {
        id: A_ASSISTANT_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "partial...",
        status: "streaming",
      },
    ];

    const res = await POST(
      makeRequest({
        type: "error",
        user_message_id: A_USER_MSG,
        assistant_message_id: A_ASSISTANT_MSG,
        error: "the bridge fell over",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === A_ASSISTANT_MSG);
    expect(asst?.status).toBe("error");
    expect(asst?.error).toBe("the bridge fell over");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("error");
  });

  it("positive control: an owned user row only (no assistant id) inserts an error row -> { ok: true }", async () => {
    // The prompt is owned and there is no assistant row yet: handleError inserts
    // a fresh assistant error row. Something WAS done, so the handler reports ok.
    fakeDb.canvas_assistant_message = [
      {
        id: A_USER_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "user",
        content: "prompt",
        status: "running",
      },
    ];

    const res = await POST(
      makeRequest({
        type: "error",
        user_message_id: A_USER_MSG,
        error: "never even started",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const inserted = fakeDb.canvas_assistant_message.filter(
      (r) => r.role === "assistant" && r.status === "error",
    );
    expect(inserted).toHaveLength(1);
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("error");
  });
});

describe("event route — handleFinish secondary-write resilience (Behavior 3)", () => {
  function seedLiveTurn() {
    fakeDb.canvas_assistant_thread = [
      { id: "thread-real", deck_id: "deck-a", user_id: USER_A, claude_session_id: null },
    ];
    fakeDb.canvas_assistant_message = [
      {
        id: A_USER_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "user",
        content: "prompt",
        status: "running",
      },
      {
        id: A_ASSISTANT_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "streaming...",
        status: "streaming",
      },
    ];
  }

  it("a failing USER-row close-out is best-effort: finish still returns { ok: true }", async () => {
    // The assistant-row update (the actual answer) succeeds; only the prompt
    // close-out write errors. Post-fix this is logged and swallowed — the finish
    // must still report success, NOT 500, because the answer is already saved.
    seedLiveTurn();
    failOnUpdate = { table: "canvas_assistant_message", id: A_USER_MSG };

    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: A_ASSISTANT_MSG,
        user_message_id: A_USER_MSG,
        content: "final answer",
        session_id: "sess-XYZ",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The critical (assistant) write landed despite the secondary failure.
    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === A_ASSISTANT_MSG);
    expect(asst?.status).toBe("complete");
    expect(asst?.content).toBe("final answer");
    // The session pointer (also best-effort) still landed.
    const thread = fakeDb.canvas_assistant_thread.find((r) => r.id === "thread-real");
    expect(thread?.claude_session_id).toBe("sess-XYZ");
  });

  it("guard against over-correction: a failing ASSISTANT-row update still 500s", async () => {
    // The assistant row is the actual answer — its write is critical. If it
    // errors the finish MUST 500 (write_failed), so the fix doesn't go too far
    // and swallow the primary write too.
    seedLiveTurn();
    failOnUpdate = { table: "canvas_assistant_message", id: A_ASSISTANT_MSG };

    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: A_ASSISTANT_MSG,
        user_message_id: A_USER_MSG,
        content: "final answer",
        session_id: "sess-XYZ",
      }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "write_failed" });
  });

  it("control: both writes succeed -> { ok: true } and both rows complete", async () => {
    seedLiveTurn();

    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: A_ASSISTANT_MSG,
        user_message_id: A_USER_MSG,
        content: "final answer",
        session_id: "sess-XYZ",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === A_ASSISTANT_MSG);
    expect(asst?.status).toBe("complete");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("complete");
  });
});
