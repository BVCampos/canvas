// Server-action tests for the in-app assistant chatbox (ADR-0006 / ADR-0007).
//
// sendAssistantMessage enqueues a prompt; deleteAssistantThread drops a
// conversation. Both run under the user's RLS via the cookie-bound server
// client. We mock @/lib/supabase/server's createClient entirely (so next/headers
// never loads) and drive an in-memory store, asserting: first message creates a
// thread titled from the prompt (truncated to TITLE_LEN=80) and the prompt row
// carries the resolved thread_id; an existing threadId is reused (no new thread);
// and empty / too_long / unauthenticated each return their stable code.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b2";
const DECK_ID = "deck-actions-1";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

// The signed-in user createClient().auth.getUser() returns. null simulates an
// unauthenticated caller.
let currentUser: { id: string } | null = { id: USER_ID };
let insertSeq = 0;

type Filter = { column: string; value: unknown };

// Minimal builder for the actions' surface: select/eq/maybeSingle (deck read),
// insert/select/single (thread + message), and delete/eq (thread delete).
class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
  private op: "select" | "insert" | "delete" = "select";
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
    return this;
  }
  delete() {
    this.op = "delete";
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

  async single(): Promise<{ data: Row | null; error: null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    const inserted = this.insertRows.map((r) => ({ id: `row-${insertSeq++}`, ...r }));
    table.push(...inserted);
    return { data: inserted[0] ?? null, error: null };
  }

  // delete().eq()... is awaited directly.
  then<T>(onFulfilled?: (value: { data: Row[]; error: null }) => T): Promise<T> {
    return this.execute().then(onFulfilled as (v: { data: Row[]; error: null }) => T);
  }

  private async execute(): Promise<{ data: Row[]; error: null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);
    if (this.op === "delete") {
      const kept = table.filter((r) => !this.matchRow(r));
      const removed = table.filter((r) => this.matchRow(r));
      fakeDb[this.table] = kept;
      return { data: removed, error: null };
    }
    return { data: table.filter((r) => this.matchRow(r)), error: null };
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
  auth: {
    getUser: async () => ({ data: { user: currentUser }, error: null }),
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabase,
}));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));
vi.mock("@/lib/canvas/assistant/openrouter-config", () => ({
  getOpenRouterConfigSummary: vi.fn(async () => ({
    configured: true,
    encryptionReady: true,
    keyHint: "••••test",
    modelId: "openrouter/auto",
    defaultRuntime: "openrouter",
    validatedAt: new Date().toISOString(),
  })),
}));

import { sendAssistantMessage, deleteAssistantThread } from "../src/app/canvases/[id]/assistant-actions";

function seedDeck() {
  fakeDb.canvas_deck = [{ id: DECK_ID, workspace_id: WORKSPACE }];
}

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  currentUser = { id: USER_ID };
  insertSeq = 0;
  vi.clearAllMocks();
});

describe("sendAssistantMessage", () => {
  it("first message: creates a thread titled from the prompt and stamps the prompt's thread_id", async () => {
    seedDeck();
    const res = await sendAssistantMessage(DECK_ID, null, "  Tighten the intro slide  ");

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    // A thread was created, titled from the trimmed prompt.
    const threads = fakeDb.canvas_assistant_thread ?? [];
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe("Tighten the intro slide");
    expect(threads[0].user_id).toBe(USER_ID);
    expect(threads[0].workspace_id).toBe(WORKSPACE);
    expect(res.threadId).toBe(threads[0].id);

    // The prompt row is queued, trimmed, and carries the resolved thread_id.
    const msgs = fakeDb.canvas_assistant_message ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].thread_id).toBe(threads[0].id);
    expect(msgs[0].content).toBe("Tighten the intro slide");
    expect(msgs[0].status).toBe("queued");
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].execution_runtime).toBe("bridge");
    expect(res.id).toBe(msgs[0].id);
  });

  it("stamps an OpenRouter prompt so the local bridge cannot claim it", async () => {
    seedDeck();
    const res = await sendAssistantMessage(
      DECK_ID,
      null,
      "Use the API runtime",
      "openrouter",
    );
    expect(res.ok).toBe(true);
    expect(fakeDb.canvas_assistant_message?.[0].execution_runtime).toBe(
      "openrouter",
    );
  });

  it("truncates a long title to 80 chars while keeping the full prompt content", async () => {
    seedDeck();
    const long = "x".repeat(200);
    const res = await sendAssistantMessage(DECK_ID, null, long);
    expect(res.ok).toBe(true);

    const thread = (fakeDb.canvas_assistant_thread ?? [])[0];
    expect((thread.title as string).length).toBe(80);
    // Content is NOT truncated to the title length — the full prompt is queued.
    const msg = (fakeDb.canvas_assistant_message ?? [])[0];
    expect((msg.content as string).length).toBe(200);
  });

  it("existing threadId: reuses it, creating NO new thread", async () => {
    seedDeck();
    fakeDb.canvas_assistant_thread = [
      { id: "thread-existing", deck_id: DECK_ID, workspace_id: WORKSPACE, user_id: USER_ID, title: "older" },
    ];

    const res = await sendAssistantMessage(DECK_ID, "thread-existing", "follow-up question");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    // No second thread was inserted.
    expect(fakeDb.canvas_assistant_thread).toHaveLength(1);
    expect(res.threadId).toBe("thread-existing");
    const msg = (fakeDb.canvas_assistant_message ?? [])[0];
    expect(msg.thread_id).toBe("thread-existing");
  });

  it("empty prompt -> {ok:false, error:'empty'} with no DB writes", async () => {
    seedDeck();
    const res = await sendAssistantMessage(DECK_ID, null, "   ");
    expect(res).toEqual({ ok: false, error: "empty" });
    expect(fakeDb.canvas_assistant_thread).toBeUndefined();
    expect(fakeDb.canvas_assistant_message).toBeUndefined();
  });

  it("too-long prompt (>8000) -> {ok:false, error:'too_long'}", async () => {
    seedDeck();
    const res = await sendAssistantMessage(DECK_ID, null, "y".repeat(8001));
    expect(res).toEqual({ ok: false, error: "too_long" });
    expect(fakeDb.canvas_assistant_message).toBeUndefined();
  });

  it("unauthenticated -> {ok:false, error:'unauthenticated'}", async () => {
    seedDeck();
    currentUser = null;
    const res = await sendAssistantMessage(DECK_ID, null, "hello");
    expect(res).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("deck not visible (RLS miss) -> {ok:false, error:'deck_not_found'}", async () => {
    // No deck seeded -> the RLS-gated read returns null.
    const res = await sendAssistantMessage("deck-nope", null, "hello");
    expect(res).toEqual({ ok: false, error: "deck_not_found" });
  });
});

describe("deleteAssistantThread", () => {
  it("deletes the user's own thread scoped by id+deck+user", async () => {
    fakeDb.canvas_assistant_thread = [
      { id: "thread-del", deck_id: DECK_ID, user_id: USER_ID, title: "to delete" },
      { id: "thread-keep", deck_id: DECK_ID, user_id: USER_ID, title: "keep" },
    ];

    const res = await deleteAssistantThread(DECK_ID, "thread-del");
    expect(res).toEqual({ ok: true });
    const remaining = (fakeDb.canvas_assistant_thread ?? []).map((r) => r.id);
    expect(remaining).toEqual(["thread-keep"]);
  });

  it("unauthenticated -> {ok:false, error:'unauthenticated'}", async () => {
    currentUser = null;
    const res = await deleteAssistantThread(DECK_ID, "thread-del");
    expect(res).toEqual({ ok: false, error: "unauthenticated" });
  });
});
