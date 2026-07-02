// Lifecycle tests for the assistant bridge event route (ADR-0006 / ADR-0007).
//
// These cover the handler branches that the cross-tenant ownership suite
// (assistant-event-ownership.test.ts) doesn't: start's server-authoritative
// thread inheritance (anti-misroute), error's two write paths + the I1
// idempotency guard, finish's `.neq("status","error")` guard, the delta
// wipe-guard, and the auth-fail short-circuit.
//
// The in-memory QueryBuilder is the same shape as the ownership suite's, EXTENDED
// to honor `.neq()` — the finish/error idempotency guards filter on
// `.neq("status", ...)`, and a mock that ignored neq() would make the guard
// tests pass vacuously. Here neq() actually excludes matching rows, so the guard
// tests would FAIL if the route dropped the `.neq(...)` clause.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE = "00000000-0000-0000-0000-0000000000ff";

// Mutable auth result so a single test can force the 401 short-circuit path
// without re-mocking the module per case.
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

// logUsage is fire-and-forget and reaches for the admin client; stub it out so
// the route under test doesn't try to build a real Supabase connection.
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { POST } from "../src/app/api/assistant/bridge/event/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

// Counters that prove writes are short-circuited (not just that the response is
// the right shape). insertAttempts/updateAttempts increment the moment the route
// calls .insert()/.update(), BEFORE any predicate runs — so a 404/401 gate that
// returns early leaves them at 0.
let insertAttempts = 0;
let updateAttempts = 0;
let insertSeq = 0;

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

  // The idempotency guards filter on `.neq("status", ...)`. Honor it for real:
  // a row whose column EQUALS the value is excluded from the match set, so an
  // already-settled row is left untouched. Without this the guard tests would
  // pass even if the route dropped its `.neq(...)`.
  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  private matchRow(row: Row): boolean {
    return this.filters.every((f) =>
      f.kind === "eq" ? row[f.column] === f.value : row[f.column] !== f.value,
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
  resetAuthOk();
  vi.clearAllMocks();
});

// Default every test to the happy auth path; individual tests override.
resetAuthOk();

const A_USER_MSG = "user-aaaa-0000-0000-0000-000000000001";

function seedOwnedUserPrompt(threadId: string) {
  fakeDb.canvas_assistant_message = [
    {
      id: A_USER_MSG,
      deck_id: "deck-a",
      workspace_id: WORKSPACE,
      user_id: USER_A,
      thread_id: threadId,
      role: "user",
      content: "make slide 2 bolder",
      status: "running",
    },
  ];
}

describe("event route — handleStart thread inheritance (anti-misroute)", () => {
  it("inherits the prompt's thread_id, IGNORING a foreign thread_id on the body", async () => {
    // The owned user prompt lives on thread-real; the bridge sends a garbage
    // thread_id. The inserted assistant row must take the prompt's thread_id
    // (server-authoritative), never the bridge-supplied one.
    seedOwnedUserPrompt("thread-real");

    const res = await POST(
      makeRequest({
        type: "start",
        user_message_id: A_USER_MSG,
        deck_id: "deck-a",
        thread_id: "thread-FOREIGN-injected", // ignored by the route
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; assistant_message_id: string };
    expect(body.ok).toBe(true);

    const inserted = fakeDb.canvas_assistant_message.find(
      (r) => r.role === "assistant" && r.id === body.assistant_message_id,
    );
    expect(inserted).toBeTruthy();
    // The load-bearing assertion: the row inherited the OWNED prompt's thread,
    // not the bridge's stray thread_id.
    expect(inserted?.thread_id).toBe("thread-real");
    expect(inserted?.thread_id).not.toBe("thread-FOREIGN-injected");
    expect(inserted?.status).toBe("streaming");
    expect(inserted?.user_id).toBe(USER_A);
    expect(inserted?.workspace_id).toBe(WORKSPACE);
    // The returned id points at the freshly-inserted assistant row.
    expect(body.assistant_message_id).toBe(inserted?.id);
  });

  it("cross-user: A's token + B's user_message_id -> 404 and ZERO inserts", async () => {
    // The prompt is owned by B; A's token must not be able to open an assistant
    // row against it. ownRow() rejects before any insert runs.
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
    ];

    const res = await POST(
      makeRequest({
        type: "start",
        user_message_id: "user-bbbb-0000-0000-0000-000000000002",
        deck_id: "deck-b",
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    // No assistant row was opened — the gate stopped before the insert.
    expect(insertAttempts).toBe(0);
    expect(fakeDb.canvas_assistant_message.filter((r) => r.role === "assistant")).toHaveLength(0);
  });
});

describe("event route — handleError branches + I1 idempotency guard", () => {
  it("(a) with an owned assistant_message_id: flips assistant AND user rows to error", async () => {
    const ASSISTANT_ID = "asst-aaaa-0000-0000-0000-000000000010";
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
        id: ASSISTANT_ID,
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
        assistant_message_id: ASSISTANT_ID,
        error: "the bridge fell over",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    expect(asst?.status).toBe("error");
    expect(asst?.error).toBe("the bridge fell over");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("error");
    // No fresh assistant row was inserted — the existing one was reused.
    expect(insertAttempts).toBe(0);
  });

  it("(b) with NO assistant_message_id: inserts a fresh assistant error row under the token's user", async () => {
    seedOwnedUserPrompt("thread-real");

    const res = await POST(
      makeRequest({
        type: "error",
        user_message_id: A_USER_MSG,
        error: "never even started",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const errorRows = fakeDb.canvas_assistant_message.filter(
      (r) => r.role === "assistant" && r.status === "error",
    );
    expect(errorRows).toHaveLength(1);
    const fresh = errorRows[0];
    // Stamped with the TOKEN's user/workspace, inheriting the prompt's thread.
    expect(fresh.user_id).toBe(USER_A);
    expect(fresh.workspace_id).toBe(WORKSPACE);
    expect(fresh.thread_id).toBe("thread-real");
    expect(fresh.deck_id).toBe("deck-a");
    expect(fresh.error).toBe("never even started");
    // The prompt row also flipped to error.
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("error");
  });

  it("(b') a non-string error gets the default message, clamped", async () => {
    seedOwnedUserPrompt("thread-real");
    const res = await POST(
      makeRequest({ type: "error", user_message_id: A_USER_MSG, error: 12345 }),
    );
    expect(res.status).toBe(200);
    const fresh = fakeDb.canvas_assistant_message.find(
      (r) => r.role === "assistant" && r.status === "error",
    );
    expect(fresh?.error).toBe("The local assistant hit an error.");
  });

  it("(c) I1 guard: a late error must NOT resurrect an already-complete turn", async () => {
    // The turn already finished: both rows are 'complete'. A retried error POST
    // arrives. The `.neq("status","complete")` guard must exclude both rows, so
    // they STAY complete. If the guard were removed, the mock's neq() would no
    // longer filter and the rows would flip to "error" — this test would fail.
    const ASSISTANT_ID = "asst-cccc-0000-0000-0000-000000000020";
    fakeDb.canvas_assistant_message = [
      {
        id: A_USER_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "user",
        content: "prompt",
        status: "complete",
      },
      {
        id: ASSISTANT_ID,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "the finished answer",
        status: "complete",
      },
    ];

    const res = await POST(
      makeRequest({
        type: "error",
        user_message_id: A_USER_MSG,
        assistant_message_id: ASSISTANT_ID,
        error: "late retry error",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    // Guard held: still complete, content intact, no error stamped.
    expect(asst?.status).toBe("complete");
    expect(asst?.content).toBe("the finished answer");
    expect(asst?.error).toBeUndefined();
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("complete");
  });

  it("(d) mixed state: the prompt guard holds independently — a reapable assistant flips to error while an already-complete prompt stays complete", async () => {
    // The bridge opened an assistant row (still 'streaming'), but the prompt row
    // was already settled 'complete' by an earlier finish (a race the bridge can
    // produce when it retries an error after the finish landed). handleError must
    // flip ONLY the assistant; the prompt-row `.neq("status","complete")` guard
    // (route.ts) must leave the completed prompt alone. The existing I1 test seeds
    // BOTH rows complete, so the assistant guard short-circuits before the prompt
    // guard is ever exercised — this case drives the prompt guard in isolation.
    const ASSISTANT_ID = "asst-mixe-0000-0000-0000-000000000021";
    fakeDb.canvas_assistant_message = [
      {
        id: A_USER_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "user",
        content: "prompt",
        status: "complete",
      },
      {
        id: ASSISTANT_ID,
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
        assistant_message_id: ASSISTANT_ID,
        error: "bridge died after the prompt was marked complete",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    // Assistant was 'streaming' (not 'complete'), so it passes the guard and errors.
    expect(asst?.status).toBe("error");
    expect(asst?.error).toBe("bridge died after the prompt was marked complete");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    // Prompt guard held: a completed prompt is NOT flipped back to error.
    expect(user?.status).toBe("complete");
  });

  it("cross-user: A's token + B's ids on error -> 404, zero writes", async () => {
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

    // Neither id is owned by A -> both ownRow() return null -> the handler does
    // nothing and reports ok. The critical assertion is that NOTHING was written.
    expect(updateAttempts).toBe(0);
    expect(insertAttempts).toBe(0);
    const asst = fakeDb.canvas_assistant_message.find(
      (r) => r.id === "asst-bbbb-0000-0000-0000-000000000003",
    );
    expect(asst?.status).toBe("streaming");
    expect(asst?.content).toBe("B's stream");
    const user = fakeDb.canvas_assistant_message.find(
      (r) => r.id === "user-bbbb-0000-0000-0000-000000000002",
    );
    expect(user?.status).toBe("running");
    void res;
  });
});

describe("event route — handleFinish idempotency guard", () => {
  it("a finish must NOT flip an already-errored assistant row to complete", async () => {
    // The reaper (or an earlier error) already settled this turn as 'error'. A
    // late finish arrives. The `.neq("status","error")` guard excludes the row,
    // so it stays 'error'. Drop the guard and the mock's neq() stops filtering →
    // the row would flip to "complete" and this test would fail.
    const ASSISTANT_ID = "asst-dddd-0000-0000-0000-000000000030";
    fakeDb.canvas_assistant_message = [
      {
        id: A_USER_MSG,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "user",
        content: "prompt",
        status: "error",
      },
      {
        id: ASSISTANT_ID,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "reaped mid-stream",
        status: "error",
        error: "The local assistant stopped responding.",
      },
    ];

    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: ASSISTANT_ID,
        user_message_id: A_USER_MSG,
        content: "here is the late, complete answer",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    // Guard held: still error, content NOT overwritten by the late finish.
    expect(asst?.status).toBe("error");
    expect(asst?.content).toBe("reaped mid-stream");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("error");
  });

  it("mixed state: the prompt guard holds independently — the assistant completes while an already-errored prompt stays errored", async () => {
    // The reaper errored the PROMPT row (a stuck 'running' user prompt past the
    // cutoff) but the assistant row is still 'streaming' and now finishes for
    // real. handleFinish must complete the assistant while the prompt-row
    // `.neq("status","error")` guard (route.ts) leaves the reaped prompt errored.
    // The existing finish-guard test seeds the ASSISTANT as error so it never
    // reaches the prompt write — this drives the prompt guard with the assistant
    // succeeding, the only path that exercises it in isolation.
    const ASSISTANT_ID = "asst-fmix-0000-0000-0000-000000000041";
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
        status: "error", // reaper already errored the prompt
      },
      {
        id: ASSISTANT_ID,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "streaming...",
        status: "streaming", // still live, now finishing
      },
    ];

    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: ASSISTANT_ID,
        user_message_id: A_USER_MSG,
        content: "final answer",
        session_id: "sess-MIX",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    // Assistant was 'streaming' (not 'error'), so its guard passes and it completes.
    expect(asst?.status).toBe("complete");
    expect(asst?.content).toBe("final answer");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    // Prompt guard held: an errored prompt is NOT flipped to complete.
    expect(user?.status).toBe("error");
    // The session pointer still lands — it's gated only on a string session_id.
    const thread = fakeDb.canvas_assistant_thread.find((r) => r.id === "thread-real");
    expect(thread?.claude_session_id).toBe("sess-MIX");
  });

  it("control: a finish on a live (streaming) turn completes both rows + stores session_id on the thread", async () => {
    const ASSISTANT_ID = "asst-eeee-0000-0000-0000-000000000040";
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
        id: ASSISTANT_ID,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "streaming...",
        status: "streaming",
      },
    ];

    const res = await POST(
      makeRequest({
        type: "finish",
        assistant_message_id: ASSISTANT_ID,
        user_message_id: A_USER_MSG,
        content: "final answer",
        session_id: "sess-XYZ",
      }),
    );

    expect(res.status).toBe(200);
    const asst = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    expect(asst?.status).toBe("complete");
    expect(asst?.content).toBe("final answer");
    const user = fakeDb.canvas_assistant_message.find((r) => r.id === A_USER_MSG);
    expect(user?.status).toBe("complete");
    // The resume pointer landed on the THREAD (ADR-0007), not the message.
    const thread = fakeDb.canvas_assistant_thread.find((r) => r.id === "thread-real");
    expect(thread?.claude_session_id).toBe("sess-XYZ");
  });
});

describe("event route — handleDelta wipe-guard (parseBridgeEvent)", () => {
  it("a non-string content -> 400 bad_field, and the owned row content is UNCHANGED", async () => {
    const ASSISTANT_ID = "asst-ffff-0000-0000-0000-000000000050";
    fakeDb.canvas_assistant_message = [
      {
        id: ASSISTANT_ID,
        deck_id: "deck-a",
        workspace_id: WORKSPACE,
        user_id: USER_A,
        thread_id: "thread-real",
        role: "assistant",
        content: "already streamed text",
        status: "streaming",
      },
    ];

    const res = await POST(
      makeRequest({ type: "delta", assistant_message_id: ASSISTANT_ID, content: 123 }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "bad_field" });
    // Rejected at parse time — no write, and the row is byte-for-byte intact (a
    // clamp() of a non-string would have wiped it to "").
    expect(updateAttempts).toBe(0);
    const row = fakeDb.canvas_assistant_message.find((r) => r.id === ASSISTANT_ID);
    expect(row?.content).toBe("already streamed text");
    expect(row?.status).toBe("streaming");
  });

  it("unknown event type -> 400 unknown_type, no writes", async () => {
    const res = await POST(makeRequest({ type: "bogus", assistant_message_id: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "unknown_type" });
    expect(updateAttempts).toBe(0);
    expect(insertAttempts).toBe(0);
  });
});

describe("event route — auth-fail short-circuit", () => {
  it("a 401 from resolveBridgeToken returns 401 and writes NO rows", async () => {
    authResult = { ok: false, status: 401, reason: "invalid_token" };
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
      makeRequest({ type: "start", user_message_id: A_USER_MSG, deck_id: "deck-a" }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_token" });
    // The auth gate fired before any DB access.
    expect(insertAttempts).toBe(0);
    expect(updateAttempts).toBe(0);
  });
});
