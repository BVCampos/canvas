// Server-action test for cancelAssistantTurn — the chatbox Stop (ADR-0008).
//
// The action verifies thread ownership under the user's RLS client, then mutates
// the in-flight rows through the service-role admin client (in-flight rows have
// no authenticated UPDATE policy). Three behaviours matter:
//   • a queued prompt (never started) is settled 'canceled' outright;
//   • a running turn with the bridge ONLINE only sets cancel_requested_at (the
//     local bridge then aborts + settles, keeping partial output);
//   • a running turn with the bridge OFFLINE is settled directly (user +
//     streaming reply), so Stop is never a no-op against a dead bridge.
// Both the user client and the admin client are mocked over one in-memory store.

import { afterEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b2";
const DECK_ID = "deck-cancel-1";
const THREAD_ID = "thread-cancel-1";

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};
let currentUser: { id: string } | null = { id: USER_ID };

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
  auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
};
const mockAdmin = { from: (table: string) => new QueryBuilder(table) };

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mockSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockAdmin }));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { cancelAssistantTurn } from "../src/app/canvases/[id]/assistant-actions";

function seedThread() {
  fakeDb.canvas_assistant_thread = [
    { id: THREAD_ID, deck_id: DECK_ID, workspace_id: WORKSPACE, user_id: USER_ID, title: "t" },
  ];
}
function seedPresence(lastSeenAt: string | null) {
  fakeDb.canvas_assistant_bridge_presence = lastSeenAt
    ? [{ user_id: USER_ID, last_seen_at: lastSeenAt }]
    : [];
}
const msg = (id: string, role: string, status: string, extra: Row = {}): Row => ({
  id,
  deck_id: DECK_ID,
  workspace_id: WORKSPACE,
  user_id: USER_ID,
  thread_id: THREAD_ID,
  role,
  content: role === "user" ? "prompt" : "partial",
  status,
  execution_runtime: "bridge",
  cancel_requested_at: null,
  ...extra,
});
const rowById = (id: string) =>
  (fakeDb.canvas_assistant_message ?? []).find((r) => r.id === id);

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  currentUser = { id: USER_ID };
  vi.clearAllMocks();
});

describe("cancelAssistantTurn", () => {
  it("settles a queued prompt to 'canceled' outright", async () => {
    seedThread();
    seedPresence(null);
    fakeDb.canvas_assistant_message = [msg("u-queued", "user", "queued")];

    const res = await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(res).toEqual({ ok: true });
    expect(rowById("u-queued")?.status).toBe("canceled");
  });

  it("bridge ONLINE: a running prompt only gets cancel_requested_at (bridge will settle)", async () => {
    seedThread();
    seedPresence(new Date().toISOString()); // fresh heartbeat → online
    fakeDb.canvas_assistant_message = [
      msg("u-run", "user", "running"),
      msg("a-stream", "assistant", "streaming"),
    ];

    const res = await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(res).toEqual({ ok: true });
    // Flag set, status untouched — the bridge aborts and settles it.
    expect(rowById("u-run")?.cancel_requested_at).not.toBeNull();
    expect(rowById("u-run")?.status).toBe("running");
    expect(rowById("a-stream")?.status).toBe("streaming");
  });

  it("bridge OFFLINE: a running turn is settled directly (prompt + streaming reply)", async () => {
    seedThread();
    seedPresence(null); // no heartbeat → offline
    fakeDb.canvas_assistant_message = [
      msg("u-run", "user", "running"),
      msg("a-stream", "assistant", "streaming"),
    ];

    const res = await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(res).toEqual({ ok: true });
    expect(rowById("u-run")?.status).toBe("canceled");
    expect(rowById("a-stream")?.status).toBe("canceled");
  });

  it("bridge OFFLINE (stale heartbeat) also settles directly", async () => {
    seedThread();
    seedPresence(new Date(Date.now() - 60_000).toISOString()); // 60s old → offline
    fakeDb.canvas_assistant_message = [msg("u-run", "user", "running")];

    await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(rowById("u-run")?.status).toBe("canceled");
  });

  it("OpenRouter: settles the server turn immediately without bridge presence", async () => {
    seedThread();
    seedPresence(null);
    fakeDb.canvas_assistant_message = [
      msg("u-api", "user", "running", { execution_runtime: "openrouter" }),
      msg("a-api", "assistant", "streaming", {
        execution_runtime: "openrouter",
      }),
    ];

    const res = await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(res).toEqual({ ok: true });
    expect(rowById("u-api")?.status).toBe("canceled");
    expect(rowById("u-api")?.cancel_requested_at).not.toBeNull();
    expect(rowById("a-api")?.status).toBe("canceled");
  });

  it("rejects a thread the user doesn't own and writes nothing", async () => {
    // No thread seeded → the RLS-scoped ownership read returns null.
    seedPresence(null);
    fakeDb.canvas_assistant_message = [msg("u-run", "user", "running")];

    const res = await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(res).toEqual({ ok: false, error: "thread_not_found" });
    expect(rowById("u-run")?.status).toBe("running");
  });

  it("unauthenticated -> {ok:false, error:'unauthenticated'}", async () => {
    currentUser = null;
    const res = await cancelAssistantTurn(DECK_ID, THREAD_ID);
    expect(res).toEqual({ ok: false, error: "unauthenticated" });
  });
});
