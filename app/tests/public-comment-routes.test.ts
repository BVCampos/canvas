// Route-level tests for the PUBLIC guest-comment surface.
//
// Targets:
//   POST /api/public/deck/{token}/comment   — the unauthenticated write.
//   GET  /api/public/deck/{token}/comments  — the per-guest scoped read.
//   POST /api/public/deck/{token}/track     — (cross-deck slide filter only).
//
// Like public-project-preview.test.ts, these drive the REAL handlers against
// an in-memory Supabase stub whose tables HONOR the filters (eq / neq / is /
// in / limit) and whose insert lands rows synchronously — so a pass proves the
// ROUTE does the gating and scoping, not the stub. rateLimitOk is mocked (it
// wraps the canvas_rate_limit_hit RPC; mocking the wrapper keeps the DB stub
// free of RPC concerns and lets each test flip allow/deny). The fire-and-forget
// notification + usage writers are pointed at the same stub via their test
// seams so we can assert what they wrote.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// --- constants ----------------------------------------------------------

const VALID_TOKEN = "AbCdEfGhIjKlMnOp"; // 16 chars, matches TOKEN_RE
const DECK_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DECK_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "10101010-1010-4010-8010-101010101010";
const OWNER_ID = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const MEMBER_ID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

const SLIDE_1 = "55555555-5555-4555-8555-555555555555";
const FOREIGN_SLIDE = "66666666-6666-4666-8666-666666666666";

const SESSION_A = "guest-session-aaaaaaaa"; // matches SESSION_RE (8..64)
const SESSION_B = "guest-session-bbbbbbbb";

// --- mocks --------------------------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSupabase,
}));

// rateLimitOk default = allowed; individual tests override per-case. The real
// wrapper calls the canvas_rate_limit_hit RPC — mocking it here is how the
// preview test controls the 429 path without a DB round-trip.
const rateLimitOk = vi.fn(async () => true);
vi.mock("@/lib/canvas/rate-limit", () => ({
  rateLimitOk: () => rateLimitOk(),
}));

// --- in-memory Supabase stub -------------------------------------------

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

// Control seam: force the NEXT insert on a given table to fail, so the route's
// "assert the row landed" branch can be exercised.
const insertControl: { failTable: string | null } = { failTable: null };

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] };

class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
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

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  // Postgres `.is(col, null)` — matches rows whose column IS NULL.
  is(column: string, value: unknown) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ kind: "in", column, values });
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

  // Insert lands rows SYNCHRONOUSLY (before the returned promise resolves) so a
  // fire-and-forget writer's row is visible the moment the route returns.
  insert(payload: Row | Row[]) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const failing = insertControl.failTable === this.table;
    const stored: Row[] = [];
    if (!failing) {
      for (const r of rows) {
        const row: Row = {
          id: typeof r.id === "string" ? r.id : nextId(),
          created_at:
            typeof r.created_at === "string"
              ? r.created_at
              : new Date().toISOString(),
          ...r,
        };
        (fakeDb[this.table] ??= []).push(row);
        stored.push(row);
      }
    }
    const error = failing
      ? { code: "23514", message: "insert failed (forced)" }
      : null;
    const single = async () => ({ data: failing ? null : stored[0], error });
    const maybeSingle = async () => ({
      data: failing ? null : (stored[0] ?? null),
      error,
    });
    return {
      select: () => ({ single, maybeSingle }),
      then: <T>(onFulfilled?: (v: { data: Row[] | null; error: unknown }) => T) =>
        Promise.resolve({ data: failing ? null : stored, error }).then(
          onFulfilled as (v: { data: Row[] | null; error: unknown }) => T,
        ),
    };
  }

  private matchRow(row: Row): boolean {
    for (const f of this.filters) {
      if (f.kind === "eq" && row[f.column] !== f.value) return false;
      if (f.kind === "neq" && row[f.column] === f.value) return false;
      if (f.kind === "is" && row[f.column] !== f.value) return false;
      if (f.kind === "in" && !f.values.includes(row[f.column])) return false;
    }
    return true;
  }

  private rows(): Row[] {
    let rows = (fakeDb[this.table] ?? []).filter((r) => this.matchRow(r));
    if (this.orderColumn) {
      const col = this.orderColumn;
      const asc = this.orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        if (av == null) return asc ? -1 : 1;
        if (bv == null) return asc ? 1 : -1;
        return asc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.rows()[0] ?? null, error: null };
  }

  then<T>(onFulfilled?: (value: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve({ data: this.rows(), error: null }).then(
      onFulfilled as (v: { data: Row[]; error: null }) => T,
    );
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
};

import { POST as COMMENT_POST } from "../src/app/api/public/deck/[token]/comment/route";
import { GET as COMMENTS_GET } from "../src/app/api/public/deck/[token]/comments/route";
import { POST as TRACK_POST } from "../src/app/api/public/deck/[token]/track/route";
import {
  __resetNotificationClientFactoryForTesting,
  __setNotificationClientFactoryForTesting,
} from "@/lib/notifications/log";
import {
  __resetUsageClientFactoryForTesting,
  __setUsageClientFactoryForTesting,
} from "@/lib/usage/log";

// --- request builders ---------------------------------------------------

type PostReq = Parameters<typeof COMMENT_POST>[0];
type GetReq = Parameters<typeof COMMENTS_GET>[0];

function callComment(token: string, body: unknown) {
  const request = {
    headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    json: async () => body,
  } as unknown as PostReq;
  return COMMENT_POST(request, { params: Promise.resolve({ token }) });
}

function callComments(token: string, session?: string) {
  const qs = session === undefined ? "" : `?session=${encodeURIComponent(session)}`;
  const request = {
    url: `http://localhost:3001/api/public/deck/${token}/comments${qs}`,
    headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
  } as unknown as GetReq;
  return COMMENTS_GET(request, { params: Promise.resolve({ token }) });
}

function callTrack(token: string, body: unknown) {
  const request = {
    headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    json: async () => body,
  } as unknown as Parameters<typeof TRACK_POST>[0];
  return TRACK_POST(request, { params: Promise.resolve({ token }) });
}

// --- shared reset -------------------------------------------------------

beforeEach(() => {
  idCounter = 0;
  insertControl.failTable = null;
  rateLimitOk.mockResolvedValue(true);
});

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  vi.clearAllMocks();
});

// ========================================================================
// POST /comment
// ========================================================================

describe("POST /api/public/deck/{token}/comment", () => {
  // Notifications are fire-and-forget and skipped in the test env unless opted
  // in; point the writer at the stub so the happy path can assert the insert.
  beforeEach(() => {
    process.env.NOTIFICATIONS_ENABLED_IN_TEST = "1";
    __setNotificationClientFactoryForTesting(
      (() => mockSupabase) as unknown as Parameters<
        typeof __setNotificationClientFactoryForTesting
      >[0],
    );
    fakeDb.canvas_deck = [
      {
        id: DECK_ID,
        public_share_token: VALID_TOKEN,
        workspace_id: WORKSPACE_ID,
        created_by: OWNER_ID,
        public_comments_enabled: true,
      },
    ];
    fakeDb.canvas_deck_member = [{ deck_id: DECK_ID, user_id: MEMBER_ID }];
    fakeDb.canvas_deck_slide = [{ id: SLIDE_1, deck_id: DECK_ID }];
  });

  afterEach(() => {
    delete process.env.NOTIFICATIONS_ENABLED_IN_TEST;
    __resetNotificationClientFactoryForTesting();
  });

  it("404s when the deck has NOT opted in, writing nothing", async () => {
    fakeDb.canvas_deck = [
      {
        id: DECK_ID,
        public_share_token: VALID_TOKEN,
        workspace_id: WORKSPACE_ID,
        created_by: OWNER_ID,
        public_comments_enabled: false,
      },
    ];
    const res = await callComment(VALID_TOKEN, {
      name: "Guest",
      body: "hi",
      website: "",
    });
    expect(res.status).toBe(404);
    expect(fakeDb.canvas_comment ?? []).toHaveLength(0);
  });

  it("fakes success on a filled honeypot and writes nothing", async () => {
    const res = await callComment(VALID_TOKEN, {
      name: "Guest",
      body: "spammy",
      website: "http://spam.example",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; id: unknown };
    expect(data.ok).toBe(true);
    expect(data.id).toBeNull();
    expect(fakeDb.canvas_comment ?? []).toHaveLength(0);
  });

  it("429s when the rate limiter denies, writing nothing", async () => {
    rateLimitOk.mockResolvedValue(false);
    const res = await callComment(VALID_TOKEN, {
      name: "Guest",
      body: "hi",
      website: "",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(fakeDb.canvas_comment ?? []).toHaveLength(0);
  });

  it("400s a slide_id that belongs to ANOTHER deck, writing nothing", async () => {
    fakeDb.canvas_deck_slide = [{ id: FOREIGN_SLIDE, deck_id: OTHER_DECK_ID }];
    const res = await callComment(VALID_TOKEN, {
      name: "Guest",
      body: "hi",
      slide_id: FOREIGN_SLIDE,
      website: "",
    });
    expect(res.status).toBe(400);
    expect(fakeDb.canvas_comment ?? []).toHaveLength(0);
  });

  it("500s with ok:false when the insert fails (never a false success)", async () => {
    insertControl.failTable = "canvas_comment";
    const res = await callComment(VALID_TOKEN, {
      name: "Guest",
      body: "hi",
      website: "",
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(false);
    expect(fakeDb.canvas_comment ?? []).toHaveLength(0);
  });

  it.each([
    ["empty name", { name: "  ", body: "hi" }],
    ["empty body", { name: "Guest", body: "   " }],
    ["over-long body", { name: "Guest", body: "x".repeat(4001) }],
    ["malformed email", { name: "Guest", body: "hi", email: "not-an-email" }],
  ])("400s on %s, writing nothing", async (_label, fields) => {
    const res = await callComment(VALID_TOKEN, { ...fields, website: "" });
    expect(res.status).toBe(400);
    expect(fakeDb.canvas_comment ?? []).toHaveLength(0);
  });

  it("lands a client row with the stored session + attempts a notification", async () => {
    const res = await callComment(VALID_TOKEN, {
      name: "Test Guest",
      email: "guest@example.com",
      body: "Looks great, one typo on slide 1.",
      slide_id: SLIDE_1,
      session: SESSION_A,
      website: "",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);

    const comments = fakeDb.canvas_comment ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      deck_id: DECK_ID,
      slide_id: SLIDE_1,
      author_kind: "client",
      author_id: null,
      author_name: "Test Guest",
      client_session: SESSION_A,
    });

    // Fire-and-forget notification write landed on the stub (owner + member).
    const notes = fakeDb.canvas_notification ?? [];
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.every((n) => n.kind === "client_comment")).toBe(true);
  });

  it("stores a NULL session when the client sends an invalid one", async () => {
    const res = await callComment(VALID_TOKEN, {
      name: "Test Guest",
      body: "no scoping for me",
      session: "bad", // < 8 chars — dropped to null, not an error
      website: "",
    });
    expect(res.status).toBe(200);
    const comments = fakeDb.canvas_comment ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0].client_session).toBeNull();
  });
});

// ========================================================================
// GET /comments — the partition
// ========================================================================

describe("GET /api/public/deck/{token}/comments", () => {
  beforeEach(() => {
    fakeDb.canvas_deck = [
      { id: DECK_ID, public_share_token: VALID_TOKEN, public_comments_enabled: true },
    ];
    fakeDb.users = [{ id: MEMBER_ID, name: "Dana Scully" }];
    // A single deck holding, in one canvas_comment table:
    //   - an internal member root (author_kind='user')
    //   - a Claude proposal root (author_kind='claude')
    //   - guest A's client root (client_session = SESSION_A)
    //   - guest B's client root (client_session = SESSION_B)
    //   - a team reply to EACH guest's root
    fakeDb.canvas_comment = [
      {
        id: "int-root",
        deck_id: DECK_ID,
        author_kind: "user",
        author_id: MEMBER_ID,
        author_name: null,
        author_email: null,
        parent_id: null,
        client_session: null,
        body: "internal member deliberation",
        resolved: false,
        created_at: "2026-07-01T09:00:00Z",
      },
      {
        id: "claude-root",
        deck_id: DECK_ID,
        author_kind: "claude",
        author_id: MEMBER_ID,
        author_name: null,
        author_email: null,
        parent_id: null,
        client_session: null,
        body: "claude proposal note",
        resolved: false,
        created_at: "2026-07-01T09:01:00Z",
      },
      {
        id: "guest-a-root",
        deck_id: DECK_ID,
        author_kind: "client",
        author_id: null,
        author_name: "Alice",
        author_email: "alice@example.com",
        parent_id: null,
        client_session: SESSION_A,
        slide_id: SLIDE_1,
        body: "guest A feedback",
        resolved: false,
        created_at: "2026-07-01T09:02:00Z",
      },
      {
        id: "guest-b-root",
        deck_id: DECK_ID,
        author_kind: "client",
        author_id: null,
        author_name: "Bob",
        author_email: "bob@example.com",
        parent_id: null,
        client_session: SESSION_B,
        slide_id: SLIDE_1,
        body: "guest B feedback",
        resolved: false,
        created_at: "2026-07-01T09:03:00Z",
      },
      {
        id: "reply-to-a",
        deck_id: DECK_ID,
        author_kind: "user",
        author_id: MEMBER_ID,
        author_name: null,
        author_email: null,
        parent_id: "guest-a-root",
        client_session: null,
        body: "team reply to alice",
        created_at: "2026-07-01T09:04:00Z",
      },
      {
        id: "reply-to-b",
        deck_id: DECK_ID,
        author_kind: "user",
        author_id: MEMBER_ID,
        author_name: null,
        author_email: null,
        parent_id: "guest-b-root",
        client_session: null,
        body: "team reply to bob",
        created_at: "2026-07-01T09:05:00Z",
      },
    ];
  });

  it("returns ONLY the requesting guest's own thread + reply — never internal, never the other guest", async () => {
    const res = await callComments(VALID_TOKEN, SESSION_A);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      threads: Array<{
        id: string;
        author: string;
        body: string;
        replies: Array<{ author: string; body: string }>;
      }>;
    };
    expect(data.ok).toBe(true);

    // Exactly guest A's root, and nothing else.
    expect(data.threads).toHaveLength(1);
    const thread = data.threads[0];
    expect(thread.id).toBe("guest-a-root");
    expect(thread.author).toBe("Alice");
    expect(thread.body).toBe("guest A feedback");

    // The team's reply to guest A stays visible, author resolved to FIRST name.
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0].body).toBe("team reply to alice");
    expect(thread.replies[0].author).toBe("Dana");

    // Structural partition: no internal / claude root leaked.
    const ids = data.threads.map((t) => t.id);
    expect(ids).not.toContain("int-root");
    expect(ids).not.toContain("claude-root");
    // Per-guest partition: guest B's thread and its reply never appear.
    expect(ids).not.toContain("guest-b-root");

    // Belt-and-suspenders on the wire: none of the hidden content, no email,
    // no full member name is serialized anywhere in the payload.
    const wire = JSON.stringify(data);
    expect(wire).not.toContain("internal member deliberation");
    expect(wire).not.toContain("claude proposal note");
    expect(wire).not.toContain("guest B feedback");
    expect(wire).not.toContain("team reply to bob");
    expect(wire).not.toContain("alice@example.com");
    expect(wire).not.toContain("bob@example.com");
    expect(wire).not.toContain("Dana Scully");
    expect(wire).not.toContain("Scully");
  });

  it("gives guest B only their own thread — symmetry check", async () => {
    const res = await callComments(VALID_TOKEN, SESSION_B);
    const data = (await res.json()) as {
      threads: Array<{ id: string; replies: Array<{ body: string }> }>;
    };
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].id).toBe("guest-b-root");
    expect(data.threads[0].replies[0].body).toBe("team reply to bob");
  });

  it("returns empty threads when no session param is supplied", async () => {
    const res = await callComments(VALID_TOKEN);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; threads: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.threads).toEqual([]);
  });

  it("returns empty threads for a malformed session param", async () => {
    const res = await callComments(VALID_TOKEN, "short"); // < 8 chars
    expect(res.status).toBe(200);
    const data = (await res.json()) as { threads: unknown[] };
    expect(data.threads).toEqual([]);
  });

  it("404s when comments are disabled, regardless of session", async () => {
    fakeDb.canvas_deck = [
      { id: DECK_ID, public_share_token: VALID_TOKEN, public_comments_enabled: false },
    ];
    const res = await callComments(VALID_TOKEN, SESSION_A);
    expect(res.status).toBe(404);
  });
});

// ========================================================================
// POST /track — cross-deck slide filter (the one review-flagged gap)
// ========================================================================

describe("POST /api/public/deck/{token}/track — cross-deck slide filter", () => {
  beforeEach(() => {
    process.env.USAGE_LOG_ENABLED_IN_TEST = "1";
    __setUsageClientFactoryForTesting(
      (() => mockSupabase) as unknown as Parameters<
        typeof __setUsageClientFactoryForTesting
      >[0],
    );
    fakeDb.canvas_deck = [
      { id: DECK_ID, public_share_token: VALID_TOKEN, workspace_id: WORKSPACE_ID },
    ];
    // Only SLIDE_1 belongs to this deck; FOREIGN_SLIDE belongs to another.
    fakeDb.canvas_deck_slide = [
      { id: SLIDE_1, deck_id: DECK_ID },
      { id: FOREIGN_SLIDE, deck_id: OTHER_DECK_ID },
    ];
  });

  afterEach(() => {
    delete process.env.USAGE_LOG_ENABLED_IN_TEST;
    __resetUsageClientFactoryForTesting();
  });

  it("drops a slide event whose slide belongs to another deck; lands the valid one", async () => {
    const res = await callTrack(VALID_TOKEN, {
      session: "abcd1234",
      events: [
        { type: "slide", slide_id: FOREIGN_SLIDE, position: 0, ms: 1000 },
        { type: "slide", slide_id: SLIDE_1, position: 1, ms: 1200 },
      ],
    });
    expect(res.status).toBe(204);

    const events = fakeDb.canvas_usage_event ?? [];
    const slideIds = events.map((e) => e.slide_id);
    expect(slideIds).toContain(SLIDE_1);
    expect(slideIds).not.toContain(FOREIGN_SLIDE);
    // Exactly the one valid slide event landed.
    expect(events).toHaveLength(1);
  });
});
