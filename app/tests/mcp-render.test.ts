// render_slide / render_deck: the SERVER side of "give Claude eyes".
//
// These pin the parts that don't need a live Chromium: that the tools load the
// right deck/slide (admin client scoped by workspace, per-deck access gate),
// select the correct slide's image by position, and that the dispatcher emits a
// valid MCP `image` content block (base64 JPEG) instead of JSON text. The
// rasterizer (headless Chromium) and the self-contained assembler are mocked —
// the actual paint can only be verified against a live Claude MCP session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctx = {
  user_id: "00000000-0000-0000-0000-000000000001",
  workspace_id: "00000000-0000-0000-0000-000000000002",
};

// ---- Mocks ----------------------------------------------------------------
// In-memory Supabase stub (same minimal chainable shape the other MCP tests
// use) so the access gate + slide ordering run against real rows.
type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] };

class QueryBuilder {
  private filters: Filter[] = [];
  private orderColumn: string | null = null;
  private orderAsc = true;
  private wantMaybeSingle = false;

  constructor(private table: string) {}

  select() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
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
  maybeSingle() {
    this.wantMaybeSingle = true;
    return this.execute();
  }
  then<T1, T2>(
    onFulfilled?: (v: { data: Row[] | Row | null; error: null }) => T1 | PromiseLike<T1>,
    onRejected?: (r: unknown) => T2 | PromiseLike<T2>,
  ) {
    return this.execute().then(onFulfilled, onRejected);
  }

  private match(row: Row): boolean {
    for (const f of this.filters) {
      if (f.kind === "eq" && row[f.column] !== f.value) return false;
      if (f.kind === "in" && !f.values.includes(row[f.column])) return false;
    }
    return true;
  }

  private async execute(): Promise<{ data: Row[] | Row | null; error: null }> {
    let rows = (fakeDb[this.table] ?? []).filter((r) => this.match(r));
    if (this.orderColumn) {
      const col = this.orderColumn;
      const asc = this.orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        return asc ? av - bv : bv - av;
      });
    }
    if (this.wantMaybeSingle) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

const mockSupabase = { from: (t: string) => new QueryBuilder(t) };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSupabase,
}));

// Stub the self-contained assembler — we don't care about asset inlining here,
// only that the tool feeds it the deck and hands the resulting html to the
// rasterizer. Echo a sentinel so we can assert the wiring if needed.
vi.mock("@/lib/canvas/export-deck", () => ({
  assembleSelfContainedDeck: vi.fn(async () => ({
    html: "<html><body>deck</body></html>",
    assetsInlined: 0,
  })),
}));

// Stub the rasterizer: return one tiny distinct byte-buffer per slide so a test
// can prove the RIGHT slide's image came back. Order matches the slide order.
const rasterizeDeckHtml = vi.fn();
vi.mock("@/lib/canvas/slide-raster", () => ({
  rasterizeDeckHtml: (...args: unknown[]) => rasterizeDeckHtml(...args),
}));

import { dispatchMcp } from "../src/lib/canvas/mcp/server";
import { tools } from "../src/lib/canvas/mcp/tools";
import { assembleSelfContainedDeck } from "@/lib/canvas/export-deck";

const DECK_ID = "deck-rndr-0000-0000-0000-000000000001";
const S0 = "slid-rndr-0000-0000-0000-000000000010";
const S1 = "slid-rndr-0000-0000-0000-000000000011";
const S2 = "slid-rndr-0000-0000-0000-000000000012";

function resetDb() {
  for (const k of Object.keys(fakeDb)) delete fakeDb[k];
}

beforeEach(() => {
  resetDb();
  fakeDb.canvas_deck = [
    {
      id: DECK_ID,
      workspace_id: ctx.workspace_id,
      visibility: "workspace",
      title: "Pitch",
      theme_css: "",
      nav_js: "",
      meta: {},
    },
  ];
  // Three slides, deliberately inserted out of order to prove the tool reads
  // them ordered by position (S0=0, S1=1, S2=2).
  fakeDb.canvas_deck_slide = [
    { id: S2, workspace_id: ctx.workspace_id, deck_id: DECK_ID, position: 2, title: "Close", html_body: "<section data-canvas-position>c</section>", slide_styles: "" },
    { id: S0, workspace_id: ctx.workspace_id, deck_id: DECK_ID, position: 0, title: "Cover", html_body: "<section data-canvas-position>a</section>", slide_styles: "" },
    { id: S1, workspace_id: ctx.workspace_id, deck_id: DECK_ID, position: 1, title: "Body", html_body: "<section data-canvas-position>b</section>", slide_styles: "" },
  ];
  fakeDb.workspace_memberships = [
    { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
  ];
  // Three distinct 1-byte JPEGs (values 10/11/12) so the index→image mapping is
  // checkable. Real shots are full JPEGs; the bytes are opaque to the tool.
  rasterizeDeckHtml.mockResolvedValue({
    size: { w: 1920, h: 1080 },
    shots: [Uint8Array.of(10), Uint8Array.of(11), Uint8Array.of(12)],
  });
});

afterEach(() => {
  resetDb();
  rasterizeDeckHtml.mockReset();
});

describe("render_slide", () => {
  // render_slide now assembles a SINGLE-slide deck (just the requested slide)
  // and returns shots[0] — the fast path (speed discovery 2026-07 #2), the same
  // single-slide shape render_proposal uses, instead of rasterizing the whole
  // deck to return shots[target]. So correctness is: the RIGHT slide is fed to
  // the assembler, and shots[0] comes back.
  it("assembles only the requested slide and returns shots[0]", async () => {
    vi.mocked(assembleSelfContainedDeck).mockClear();
    const result = (await tools.render_slide({ slide_id: S1 }, ctx)) as {
      __mcpContent: Array<{ type: string; data?: string; mimeType?: string }>;
    };
    const image = result.__mcpContent.find((p) => p.type === "image");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/jpeg");
    // Single-slide render → shots[0] = Uint8Array.of(10).
    expect(image?.data).toBe(Buffer.from(Uint8Array.of(10)).toString("base64"));
    // The assembler received ONLY slide S1 (its html_body), not the whole deck.
    const call = vi.mocked(assembleSelfContainedDeck).mock.calls.at(-1);
    const slidesArg = call?.[1] as Array<{ html_body: string }>;
    expect(slidesArg).toHaveLength(1);
    expect(slidesArg[0].html_body).toContain("b");
  });

  it("feeds a different slide's content per call (S0 vs S2)", async () => {
    vi.mocked(assembleSelfContainedDeck).mockClear();
    await tools.render_slide({ slide_id: S0 }, ctx);
    const firstSlides = vi
      .mocked(assembleSelfContainedDeck)
      .mock.calls.at(-1)?.[1] as Array<{ html_body: string }>;
    await tools.render_slide({ slide_id: S2 }, ctx);
    const lastSlides = vi
      .mocked(assembleSelfContainedDeck)
      .mock.calls.at(-1)?.[1] as Array<{ html_body: string }>;
    expect(firstSlides[0].html_body).toContain("a");
    expect(lastSlides[0].html_body).toContain("c");
  });

  it("rejects a slide outside the caller's workspace before rendering", async () => {
    fakeDb.canvas_deck_slide = [
      { id: S0, workspace_id: "another-ws", deck_id: DECK_ID, position: 0, title: "x", html_body: "", slide_styles: "" },
    ];
    await expect(tools.render_slide({ slide_id: S0 }, ctx)).rejects.toThrow(
      /not found in this workspace/,
    );
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });
});

describe("render_deck", () => {
  it("returns one image per slide, in order, each labelled", async () => {
    const result = (await tools.render_deck({ deck_id: DECK_ID }, ctx)) as {
      __mcpContent: Array<{ type: string; text?: string; data?: string }>;
    };
    const images = result.__mcpContent.filter((p) => p.type === "image");
    expect(images).toHaveLength(3);
    expect(images.map((i) => i.data)).toEqual([
      Buffer.from(Uint8Array.of(10)).toString("base64"),
      Buffer.from(Uint8Array.of(11)).toString("base64"),
      Buffer.from(Uint8Array.of(12)).toString("base64"),
    ]);
    // Labels reference the slide titles in order.
    const labels = result.__mcpContent.filter((p) => p.type === "text").map((p) => p.text);
    expect(labels.some((l) => l?.includes("Cover"))).toBe(true);
    expect(labels.some((l) => l?.includes("Close"))).toBe(true);
  });
});

describe("render_proposal", () => {
  const PROP = "edit-rndr-0000-0000-0000-000000000099";

  beforeEach(() => {
    // A pending slide_html proposal on S0 — the agent's just-proposed change.
    fakeDb.canvas_deck_edit = [
      {
        id: PROP,
        deck_id: DECK_ID,
        workspace_id: ctx.workspace_id,
        slide_id: S0,
        kind: "slide_html",
        status: "pending",
        new_content: "<section data-canvas-position>PROPOSED</section>",
        new_slide_payload: null,
      },
    ];
  });

  it("renders the slide AS the pending proposal would leave it (proposed html reaches the assembler)", async () => {
    const result = (await tools.render_proposal({ proposal_id: PROP }, ctx)) as {
      __mcpContent: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    };
    const image = result.__mcpContent.find((p) => p.type === "image");
    expect(image?.mimeType).toBe("image/jpeg");
    // Single-slide render → the first (only) shot, byte 10.
    expect(image?.data).toBe(Buffer.from(Uint8Array.of(10)).toString("base64"));
    // The assembler was fed the PROPOSED html_body, not the slide's current "a".
    const lastCall = vi.mocked(assembleSelfContainedDeck).mock.calls.at(-1);
    const slidesArg = lastCall?.[1] as Array<{ html_body: string }>;
    expect(slidesArg?.[0]?.html_body).toContain("PROPOSED");
    // The text label makes the not-yet-applied status explicit.
    const label = result.__mcpContent.find((p) => p.type === "text")?.text ?? "";
    expect(label.toLowerCase()).toContain("pending");
  });

  it("rejects a proposal whose deck is outside the caller's workspace before rendering", async () => {
    (fakeDb.canvas_deck[0] as Record<string, unknown>).workspace_id = "another-ws";
    await expect(tools.render_proposal({ proposal_id: PROP }, ctx)).rejects.toThrow(
      /not found in this workspace/,
    );
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });

  it("refuses an already-applied proposal and points at render_slide", async () => {
    (fakeDb.canvas_deck_edit[0] as Record<string, unknown>).status = "applied";
    await expect(tools.render_proposal({ proposal_id: PROP }, ctx)).rejects.toThrow(
      /not pending|render_slide/i,
    );
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });

  it("refuses a kind with nothing to preview as one slide (theme_css, no slide target)", async () => {
    Object.assign(fakeDb.canvas_deck_edit[0], { kind: "theme_css", slide_id: null });
    await expect(tools.render_proposal({ proposal_id: PROP }, ctx)).rejects.toThrow(
      /render_deck|single slide/i,
    );
    expect(rasterizeDeckHtml).not.toHaveBeenCalled();
  });

  it("404s a proposal id that doesn't exist", async () => {
    await expect(
      tools.render_proposal({ proposal_id: "edit-does-not-exist" }, ctx),
    ).rejects.toThrow(/not found/);
  });
});

describe("dispatcher emits MCP image content blocks", () => {
  it("passes render_slide's __mcpContent through as the tools/call content array", async () => {
    const out = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "render_slide", arguments: { slide_id: S0 } },
      },
      ctx,
    );
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    const result = out.body.result as {
      content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    // The content array is the tool's blocks verbatim — NOT a single JSON text
    // block. An image part with base64 data + image/jpeg mimeType per MCP spec.
    const image = result.content.find((p) => p.type === "image");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/jpeg");
    expect(typeof image?.data).toBe("string");
    // Valid base64: round-trips back to the original single byte.
    expect(Buffer.from(image!.data!, "base64")).toEqual(Buffer.from(Uint8Array.of(10)));
  });

  it("still wraps a normal tool's object result in one JSON text block", async () => {
    const out = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_slide", arguments: { slide_id: S0 } },
      },
      ctx,
    );
    if (out.kind !== "response") throw new Error("unreachable");
    const result = out.body.result as { content: Array<{ type: string; text?: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // Parseable JSON — read_slide returns a plain object.
    expect(() => JSON.parse(result.content[0].text!)).not.toThrow();
  });
});
