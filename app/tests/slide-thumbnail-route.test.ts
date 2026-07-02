// Tests for the slide-thumbnail route.
//
// Target: src/app/api/decks/[id]/slides/[slideId]/thumbnail/route.ts (GET).
//
// What we CAN verify here (no Chromium): auth (401 / 404 gating), that the
// proposed-vs-current selection feeds the assembler the RIGHT slide content,
// the response shape (image/jpeg body), the cache-control keying (immutable for
// a named version, short for current/proposal), and the ConcurrencyGate's 429
// on saturation. The actual paint (rasterizeDeckHtml -> JPEG bytes) is mocked —
// it can only be verified against a live headless Chromium.
//
// assembleSelfContainedDeck is mocked AND captures the slideRows it received so
// a test can assert which content the route chose (current body vs the
// proposal's new_content vs new_slide_payload vs a version's body). The
// rasterizer is mocked to return a fixed 1-byte JPEG, with a controllable
// "block" mode so the saturation (429) test is deterministic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DECK_ID = "11111111-1111-4111-8111-111111111111";
const SLIDE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SLIDE_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";

// --- mocks --------------------------------------------------------------

// Auth: controllable user. Default = signed in; the 401 test nulls it.
let currentUser: { id: string } | null = { id: "user-1" };

// Capture what the assembler was handed so we can assert the chosen content.
type CapturedSlide = {
  position: number;
  title: string;
  html_body: string;
  slide_styles: string | null;
};
let lastAssembledSlides: CapturedSlide[] | null = null;
const assembleSelfContainedDeck = vi.fn(
  async (_deck: unknown, slideRows: CapturedSlide[]) => {
    lastAssembledSlides = slideRows;
    return { html: "<html><body>thumb</body></html>", assetsInlined: 0 };
  },
);
vi.mock("@/lib/canvas/export-deck", () => ({
  assembleSelfContainedDeck: (...args: unknown[]) =>
    assembleSelfContainedDeck(args[0], args[1] as CapturedSlide[]),
}));

// Rasterizer: returns one fixed 1-byte JPEG. In "block" mode the first call
// hangs on a manually-resolved promise so a second request hits a full gate.
let rasterBlock: { promise: Promise<void>; resolve: () => void } | null = null;
const rasterizeDeckHtml = vi.fn(async () => {
  if (rasterBlock) await rasterBlock.promise;
  return { size: { w: 1920, h: 1080 }, shots: [Uint8Array.of(7)] };
});
vi.mock("@/lib/canvas/slide-raster", () => ({
  rasterizeDeckHtml: () => rasterizeDeckHtml(),
}));

// --- in-memory Supabase stub -------------------------------------------

type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

class QueryBuilder {
  private filters: Array<{ column: string; value: unknown }> = [];
  constructor(private table: string) {}
  select() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }
  private match(row: Row): boolean {
    return this.filters.every((f) => row[f.column] === f.value);
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = (fakeDb[this.table] ?? []).filter((r) => this.match(r));
    return { data: rows[0] ?? null, error: null };
  }
}

const mockSupabase = {
  auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
  from: (table: string) => new QueryBuilder(table),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabase,
}));

import { GET } from "../src/app/api/decks/[id]/slides/[slideId]/thumbnail/route";

// Minimal NextRequest-shaped stub: the route reads only nextUrl.searchParams.
function makeRequest(query: Record<string, string> = {}): Parameters<typeof GET>[0] {
  const sp = new URLSearchParams(query);
  return {
    nextUrl: { searchParams: sp },
  } as unknown as Parameters<typeof GET>[0];
}

function call(
  id: string,
  slideId: string,
  query: Record<string, string> = {},
) {
  return GET(makeRequest(query), {
    params: Promise.resolve({ id, slideId }),
  });
}

beforeEach(() => {
  currentUser = { id: "user-1" };
  rasterBlock = null;
  lastAssembledSlides = null;
  fakeDb.canvas_deck = [
    { id: DECK_ID, title: "Deck", theme_css: "", nav_js: "", meta: {} },
  ];
  fakeDb.canvas_deck_slide = [
    {
      id: SLIDE_ID,
      deck_id: DECK_ID,
      title: "Cover",
      html_body: "<section data-canvas-position>current</section>",
      slide_styles: ".a{}",
    },
  ];
  fakeDb.canvas_deck_edit = [];
  fakeDb.canvas_slide_version = [];
});

afterEach(() => {
  for (const k of Object.keys(fakeDb)) delete fakeDb[k];
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// Let the route's async hops (auth + two db lookups) settle so a fired burst has
// reached the gate before we probe it.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("slide thumbnail — auth + lookup gating", () => {
  it("401s when there is no signed-in user (before any render)", async () => {
    currentUser = null;
    const res = await call(DECK_ID, SLIDE_ID);
    expect(res.status).toBe(401);
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });

  it("404s when the deck isn't readable", async () => {
    const res = await call("99999999-9999-4999-8999-999999999999", SLIDE_ID);
    expect(res.status).toBe(404);
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });

  it("404s when the slide isn't in this deck", async () => {
    const res = await call(DECK_ID, OTHER_SLIDE_ID);
    expect(res.status).toBe(404);
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });
});

describe("slide thumbnail — content selection", () => {
  it("renders the slide's CURRENT content by default, short-cache", async () => {
    const res = await call(DECK_ID, SLIDE_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    // The assembler got a single slide carrying the CURRENT body.
    expect(lastAssembledSlides).toHaveLength(1);
    expect(lastAssembledSlides![0].html_body).toContain("current");
    // Body is the rasterizer's fixed 1-byte JPEG.
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf).toEqual(Buffer.from(Uint8Array.of(7)));
  });

  it("?proposalId renders the slide_html proposal's new_content", async () => {
    fakeDb.canvas_deck_edit = [
      {
        id: PROPOSAL_ID,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        kind: "slide_html",
        status: "pending",
        new_content: "<section data-canvas-position>PROPOSED</section>",
        new_slide_payload: null,
      },
    ];
    const res = await call(DECK_ID, SLIDE_ID, { proposalId: PROPOSAL_ID });
    expect(res.status).toBe(200);
    expect(lastAssembledSlides![0].html_body).toContain("PROPOSED");
    // A pending proposal is mutable, so it stays short-cached.
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });

  it("?proposalId merges a bundled slide_edit payload (present fields win, absent kept)", async () => {
    fakeDb.canvas_deck_edit = [
      {
        id: PROPOSAL_ID,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        kind: "slide_edit",
        status: "pending",
        new_content: null,
        // Only html_body changes; slide_styles is absent -> keep current ".a{}".
        new_slide_payload: { html_body: "<section data-canvas-position>BUNDLED</section>" },
      },
    ];
    const res = await call(DECK_ID, SLIDE_ID, { proposalId: PROPOSAL_ID });
    expect(res.status).toBe(200);
    expect(lastAssembledSlides![0].html_body).toContain("BUNDLED");
    expect(lastAssembledSlides![0].slide_styles).toBe(".a{}");
  });

  it("ignores a proposal targeting a DIFFERENT slide (falls back to current)", async () => {
    fakeDb.canvas_deck_edit = [
      {
        id: PROPOSAL_ID,
        deck_id: DECK_ID,
        slide_id: OTHER_SLIDE_ID, // not the slide in the URL
        kind: "slide_html",
        status: "pending",
        new_content: "<section data-canvas-position>WRONG</section>",
        new_slide_payload: null,
      },
    ];
    const res = await call(DECK_ID, SLIDE_ID, { proposalId: PROPOSAL_ID });
    expect(res.status).toBe(200);
    expect(lastAssembledSlides![0].html_body).toContain("current");
    expect(lastAssembledSlides![0].html_body).not.toContain("WRONG");
  });

  it("ignores a non-pending proposal (falls back to current)", async () => {
    fakeDb.canvas_deck_edit = [
      {
        id: PROPOSAL_ID,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        kind: "slide_html",
        status: "applied", // not pending -> the .eq('status','pending') drops it
        new_content: "<section data-canvas-position>APPLIED</section>",
        new_slide_payload: null,
      },
    ];
    const res = await call(DECK_ID, SLIDE_ID, { proposalId: PROPOSAL_ID });
    expect(res.status).toBe(200);
    expect(lastAssembledSlides![0].html_body).toContain("current");
  });

  it("?versionId renders that version's content with an immutable cache", async () => {
    fakeDb.canvas_slide_version = [
      {
        id: VERSION_ID,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        title: "Old",
        html_body: "<section data-canvas-position>VERSION</section>",
        slide_styles: ".old{}",
      },
    ];
    const res = await call(DECK_ID, SLIDE_ID, { versionId: VERSION_ID });
    expect(res.status).toBe(200);
    expect(lastAssembledSlides![0].html_body).toContain("VERSION");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=31536000, immutable",
    );
  });

  it("ignores a versionId belonging to a different slide (current, short cache)", async () => {
    fakeDb.canvas_slide_version = [
      {
        id: VERSION_ID,
        deck_id: DECK_ID,
        slide_id: OTHER_SLIDE_ID,
        title: "Other",
        html_body: "<section data-canvas-position>OTHERVER</section>",
        slide_styles: "",
      },
    ];
    const res = await call(DECK_ID, SLIDE_ID, { versionId: VERSION_ID });
    expect(res.status).toBe(200);
    expect(lastAssembledSlides![0].html_body).toContain("current");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });
});

describe("slide thumbnail — concurrency gate", () => {
  it("queues a burst behind the gate and drains every request to 200 (no 429)", async () => {
    // Hold the in-flight renders open so their gate slots stay taken; the rest of
    // the burst parks in the wait queue (runOrWait) rather than being shed. The
    // burst is larger than any reasonable concurrency ceiling, smaller than the
    // queue depth — so with queueing NOTHING should 429.
    let resolveBlock!: () => void;
    rasterBlock = {
      promise: new Promise<void>((r) => {
        resolveBlock = r;
      }),
      resolve: () => resolveBlock(),
    };

    const BURST = 16;
    const inFlight = Array.from({ length: BURST }, () => call(DECK_ID, SLIDE_ID));
    await settle(); // slots fill; the overflow parks in the queue, doesn't 429

    // Release the held renders; each release hands its slot to the next queued
    // request, cascading until the whole burst has rendered.
    resolveBlock();
    const settled = await Promise.all(inFlight);
    const statuses = settled.map((r) => r.status);
    expect(statuses).toHaveLength(BURST);
    for (const s of statuses) expect(s).toBe(200); // queue drained, none shed
  });

  it("falls back to an instant 429 (Retry-After) when waiting is disabled and the gate is full", async () => {
    // THUMBNAIL_QUEUE_WAIT_MS=0 restores the old non-blocking behaviour: overflow
    // is shed immediately instead of parking. Proves the shed path (and its env
    // knob) still works — the client-side retry is what recovers these.
    vi.stubEnv("THUMBNAIL_QUEUE_WAIT_MS", "0");

    let resolveBlock!: () => void;
    rasterBlock = {
      promise: new Promise<void>((r) => {
        resolveBlock = r;
      }),
      resolve: () => resolveBlock(),
    };

    const BURST = 16;
    const inFlight = Array.from({ length: BURST }, () => call(DECK_ID, SLIDE_ID));
    await settle();

    // One more, fired while every slot is held and waiting is off → instant 429.
    const overflow = await call(DECK_ID, SLIDE_ID);
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("Retry-After")).toBe("5");

    resolveBlock();
    const settled = await Promise.all(inFlight);
    const statuses = settled.map((r) => r.status);
    expect(statuses).toContain(200); // the ones that got a slot
    expect(statuses).toContain(429); // the rest, shed without waiting
    for (const s of statuses) expect([200, 429]).toContain(s);
  });
});
