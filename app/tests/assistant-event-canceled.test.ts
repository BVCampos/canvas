// `canceled` event handler test for the assistant bridge event route (ADR-0008).
//
// When the user Stops a running turn, the bridge POSTs a `canceled` event. The
// route must settle BOTH the prompt and reply rows to the terminal 'canceled'
// status while KEEPING the partial reply, and — because terminal states are
// mutually exclusive (first wins) — must NOT flip a row that already settled
// complete/error. The mock's neq() filters for real, so the guard is actually
// exercised (a route that dropped the guards would fail these).

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
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { POST } from "../src/app/api/assistant/bridge/event/route";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

type EqFilter = { kind: "eq"; column: string; value: unknown };
type NeqFilter = { kind: "neq"; column: string; value: unknown };
type Filter = EqFilter | NeqFilter;

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
    this.filters.push({ kind: "eq", column, value });
    return this;
  }
  // Honor neq for real so the idempotency guards are genuinely tested.
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

const mockSupabase = { from: (table: string) => new QueryBuilder(table) };

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    nextUrl: { searchParams: new URLSearchParams({ token: "tok_a" }) },
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

const USER_MSG = "msg-user-0000-0000-0000-000000000001";
const ASSISTANT_MSG = "msg-asst-0000-0000-0000-000000000002";

function seedTurn(opts: { userStatus: string; assistantStatus: string; assistantContent?: string }) {
  fakeDb.canvas_assistant_message = [
    {
      id: USER_MSG,
      deck_id: "deck-a",
      workspace_id: WORKSPACE,
      user_id: USER_A,
      thread_id: "thread-a",
      role: "user",
      content: "do the thing",
      status: opts.userStatus,
    },
    {
      id: ASSISTANT_MSG,
      deck_id: "deck-a",
      workspace_id: WORKSPACE,
      user_id: USER_A,
      thread_id: "thread-a",
      role: "assistant",
      content: opts.assistantContent ?? "partial so f",
      status: opts.assistantStatus,
    },
  ];
}

const rowById = (id: string) =>
  (fakeDb.canvas_assistant_message ?? []).find((r) => r.id === id);

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  vi.clearAllMocks();
});

describe("event route — canceled handler", () => {
  it("settles both rows to 'canceled' and keeps the partial reply", async () => {
    seedTurn({ userStatus: "running", assistantStatus: "streaming" });
    const res = await POST(
      makeRequest({
        type: "canceled",
        user_message_id: USER_MSG,
        assistant_message_id: ASSISTANT_MSG,
        content: "partial output before stop",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rowById(USER_MSG)?.status).toBe("canceled");
    expect(rowById(ASSISTANT_MSG)?.status).toBe("canceled");
    // The partial reply is preserved (not wiped), so the chatbox keeps it.
    expect(rowById(ASSISTANT_MSG)?.content).toBe("partial output before stop");
  });

  it("leaves the reply content untouched when the event omits content", async () => {
    seedTurn({ userStatus: "running", assistantStatus: "streaming", assistantContent: "kept text" });
    await POST(
      makeRequest({
        type: "canceled",
        user_message_id: USER_MSG,
        assistant_message_id: ASSISTANT_MSG,
      }),
    );
    expect(rowById(ASSISTANT_MSG)?.status).toBe("canceled");
    expect(rowById(ASSISTANT_MSG)?.content).toBe("kept text");
  });

  it("first terminal wins: a canceled event does NOT override an already-complete reply", async () => {
    seedTurn({ userStatus: "complete", assistantStatus: "complete", assistantContent: "the full answer" });
    await POST(
      makeRequest({
        type: "canceled",
        user_message_id: USER_MSG,
        assistant_message_id: ASSISTANT_MSG,
        content: "late stop",
      }),
    );
    // The completed turn is untouched — status and content stay as they were.
    expect(rowById(ASSISTANT_MSG)?.status).toBe("complete");
    expect(rowById(ASSISTANT_MSG)?.content).toBe("the full answer");
    expect(rowById(USER_MSG)?.status).toBe("complete");
  });

  it("blocks a canceled event against another user's rows: 404, no writes", async () => {
    fakeDb.canvas_assistant_message = [
      {
        id: USER_MSG,
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
      makeRequest({ type: "canceled", user_message_id: USER_MSG, content: "x" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    expect(rowById(USER_MSG)?.status).toBe("running");
  });
});
