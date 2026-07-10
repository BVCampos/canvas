// Authorization tests for the public project-scoped deck preview route.
//
// Target: src/app/api/public/project/[token]/deck/[deckId]/preview/route.ts (GET).
//
// The unguessable project `token` is the single capability for EVERY deck in the
// project; `deckId` is just a selector. The IDOR/exposure guard is the deck
// lookup's compound filter:
//
//   .eq("id", deckId).eq("project_id", project.id).neq("visibility", "private")
//
// so a deck in a DIFFERENT project, or a deck marked private, yields no row -> 404
// even when its id is known. These tests drive the real handler against an
// in-memory Supabase stub whose canvas_deck table HONORS those filters — so a
// pass proves the ROUTE's filter does the gating, not the stub.
//
// rateLimitOk, assembleDeckHtml and assetSigQuery are mocked: the 429 path is
// controlled via rateLimitOk, and assembleDeckHtml is pinned to a fixed string so
// the 200 assertion doesn't depend on real assembly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_TOKEN = "AbCdEfGhIjKlMnOp"; // 16 chars, matches TOKEN_RE
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DECK_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DECK_ID = "33333333-3333-4333-8333-333333333333";
const PRIVATE_DECK_ID = "44444444-4444-4444-8444-444444444444";
const ASSEMBLED_HTML = "<!doctype html><html><body>assembled-deck</body></html>";

// --- mocks --------------------------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSupabase,
}));

// rateLimitOk default = allowed; individual tests override per-case.
const rateLimitOk = vi.fn(async () => true);
vi.mock("@/lib/canvas/rate-limit", () => ({
  rateLimitOk: () => rateLimitOk(),
}));

// Pin assembly to a fixed string so the 200 body assertion is independent of
// the real assembler. PARTIAL mock: the route also pulls the pure gate helpers
// (needsViewportShim / detectFixedSlideSize) from this module via its shim
// telemetry, so pass the rest through and stub only assembleDeckHtml.
vi.mock("@/lib/canvas/assemble", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/canvas/assemble")>()),
  assembleDeckHtml: vi.fn(() => ASSEMBLED_HTML),
}));

// Deterministic, side-effect-free asset signature.
vi.mock("@/lib/canvas/asset-sign", () => ({
  assetSigQuery: vi.fn(() => "exp=1&sig=stub"),
}));

// --- in-memory Supabase stub -------------------------------------------

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown };

class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
  private orderColumn: string | null = null;
  private orderAsc = true;

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

  // The route excludes private decks with .neq("visibility", "private").
  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }) {
    this.orderColumn = column;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  private matchRow(row: Row): boolean {
    for (const f of this.filters) {
      if (f.kind === "eq" && row[f.column] !== f.value) return false;
      // Postgres .neq excludes only rows that EQUAL the value; a NULL/undefined
      // column is NOT excluded (matches SQL three-valued logic for our cases —
      // every seeded deck carries an explicit visibility).
      if (f.kind === "neq" && row[f.column] === f.value) return false;
    }
    return true;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = (fakeDb[this.table] ?? []).filter((r) => this.matchRow(r));
    return { data: rows[0] ?? null, error: null };
  }

  // The slides query is awaited directly (ends in .order()).
  then<T>(onFulfilled?: (value: { data: Row[]; error: null }) => T): Promise<T> {
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
    return Promise.resolve({ data: rows, error: null }).then(
      onFulfilled as (v: { data: Row[]; error: null }) => T,
    );
  }
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
};

import { GET } from "../src/app/api/public/project/[token]/deck/[deckId]/preview/route";

// Minimal NextRequest-shaped stub: the route reads only request.headers.get(...)
// for the rate-limit IP key.
function makeRequest(): Parameters<typeof GET>[0] {
  return {
    headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
  } as unknown as Parameters<typeof GET>[0];
}

function call(token: string, deckId: string) {
  return GET(makeRequest(), { params: Promise.resolve({ token, deckId }) });
}

beforeEach(() => {
  // A project owning DECK_ID + PRIVATE_DECK_ID; OTHER_DECK_ID belongs to a
  // DIFFERENT project. The stub honors project_id + visibility filters so the
  // route's compound filter — not the seed — does the gating.
  fakeDb.canvas_project = [
    { id: PROJECT_ID, public_share_token: VALID_TOKEN },
    { id: "99999999-9999-4999-8999-999999999999", public_share_token: "OtherProjectTokenXX" },
  ];
  fakeDb.canvas_deck = [
    {
      id: DECK_ID,
      project_id: PROJECT_ID,
      visibility: "workspace",
      title: "Public Deck",
      theme_css: "",
      nav_js: "",
      meta: {},
    },
    {
      id: PRIVATE_DECK_ID,
      project_id: PROJECT_ID,
      visibility: "private",
      title: "Private Deck",
      theme_css: "",
      nav_js: "",
      meta: {},
    },
    {
      id: OTHER_DECK_ID,
      project_id: "99999999-9999-4999-8999-999999999999",
      visibility: "workspace",
      title: "Deck In Another Project",
      theme_css: "",
      nav_js: "",
      meta: {},
    },
  ];
  fakeDb.canvas_deck_slide = [
    {
      id: "55555555-5555-4555-8555-555555555555",
      deck_id: DECK_ID,
      position: 0,
      title: "Slide 1",
      html_body: "<section class=\"slide\"><h1>hi</h1></section>",
      slide_styles: "",
    },
  ];
  rateLimitOk.mockResolvedValue(true);
});

afterEach(() => {
  for (const key of Object.keys(fakeDb)) delete fakeDb[key];
  vi.clearAllMocks();
});

describe("public project preview — GET authorization", () => {
  it("404s a malformed token without touching the DB", async () => {
    const fromSpy = vi.spyOn(mockSupabase, "from");
    const res = await call("short", DECK_ID); // < 16 chars, fails TOKEN_RE
    expect(res.status).toBe(404);
    expect(fromSpy).not.toHaveBeenCalled();
    expect(rateLimitOk).not.toHaveBeenCalled();
  });

  it("404s a deckId that isn't a UUID", async () => {
    const res = await call(VALID_TOKEN, "not-a-uuid");
    expect(res.status).toBe(404);
  });

  it("429s with Retry-After when the rate limiter rejects", async () => {
    rateLimitOk.mockResolvedValue(false);
    const res = await call(VALID_TOKEN, DECK_ID);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("404s a token matching no project", async () => {
    const res = await call("ZzYyXxWwVvUuTtSs", DECK_ID); // valid shape, no row
    expect(res.status).toBe(404);
  });

  it("404s a deckId that belongs to a DIFFERENT project (the IDOR case)", async () => {
    // OTHER_DECK_ID exists and is non-private, but lives in another project, so
    // the .eq('project_id', project.id) filter excludes it -> no row -> 404.
    const res = await call(VALID_TOKEN, OTHER_DECK_ID);
    expect(res.status).toBe(404);
  });

  it("404s a deck whose visibility is 'private'", async () => {
    // PRIVATE_DECK_ID is in the right project but .neq('visibility','private')
    // filters it out of the public surface.
    const res = await call(VALID_TOKEN, PRIVATE_DECK_ID);
    expect(res.status).toBe(404);
  });

  it("200s HTML with the sandbox CSP when the deck belongs to the project and isn't private", async () => {
    const res = await call(VALID_TOKEN, DECK_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts allow-popups;",
    );
    const body = await res.text();
    expect(body).toContain("assembled-deck");
  });
});
