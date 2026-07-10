// Unit tests for the MCP JSON-RPC dispatcher.
//
// These focus on the protocol surface — initialize / tools/list / unknown
// methods / notifications. Tool-call dispatch is exercised indirectly via the
// `tools/list` response (we assert every advertised tool name has a handler).
// The `comments` block below exercises the canvas_comment tools against an
// in-memory Supabase stub. Other tool-call paths still rely on a live
// Supabase and stay out of unit scope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMcp } from "../src/lib/canvas/mcp/server";
import { ensureSlideSectionWrap, lineChangeRatio, tools, toolDescriptors } from "../src/lib/canvas/mcp/tools";

const ctx = { user_id: "00000000-0000-0000-0000-000000000001", workspace_id: "00000000-0000-0000-0000-000000000002" };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSupabase,
}));

// In-memory fixture — populated by each test. The mock client below reads from
// and writes to these tables via a minimal chainable query builder that covers
// just the operations the comment tools use.
type Row = Record<string, unknown>;
const fakeDb: Record<string, Row[]> = {};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null }
  | { kind: "not_is"; column: string; value: null }
  | { kind: "in"; column: string; values: unknown[] };

class QueryBuilder {
  private table: string;
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private insertRows: Row[] = [];
  private updateValues: Row = {};
  private orderColumn: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private wantSingle = false;
  private wantMaybeSingle = false;

  constructor(table: string) {
    this.table = table;
  }

  select(_columns?: string) {
    // Column projection is ignored — the in-memory rows already carry the full
    // shape and tests assert on whatever keys they care about.
    void _columns;
    return this;
  }

  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
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

  is(column: string, value: null) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  // Only the `.not(col, "is", null)` form is used (list_projects' deck-count
  // query); anything else would silently filter wrong, so fail loud.
  not(column: string, operator: string, value: unknown) {
    if (operator !== "is" || value !== null) {
      throw new Error(`QueryBuilder.not: unsupported ${operator}/${String(value)}`);
    }
    this.filters.push({ kind: "not_is", column, value: null });
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

  single() {
    this.wantSingle = true;
    return this.execute();
  }

  maybeSingle() {
    this.wantMaybeSingle = true;
    return this.execute();
  }

  then<TResult1, TResult2>(
    onFulfilled?: (value: { data: Row[] | Row | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>,
    onRejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ) {
    return this.execute().then(onFulfilled, onRejected);
  }

  private matchRow(row: Row): boolean {
    for (const f of this.filters) {
      if (f.kind === "eq" && row[f.column] !== f.value) return false;
      // `is null` matches SQL NULL — and a column a fixture simply omits is
      // NULL in Postgres, so treat undefined as null here too (mirrors the
      // not_is branch below). Without this, `.is("archived_at", null)` would
      // drop every seeded deck that predates the archived_at column.
      if (f.kind === "is" && row[f.column] !== null && row[f.column] !== undefined) return false;
      if (f.kind === "not_is" && (row[f.column] === null || row[f.column] === undefined)) return false;
      if (f.kind === "in" && !f.values.includes(row[f.column])) return false;
    }
    return true;
  }

  private async execute(): Promise<{ data: Row[] | Row | null; error: { message: string } | null }> {
    const table = (fakeDb[this.table] = fakeDb[this.table] ?? []);

    if (this.op === "insert") {
      const inserted = this.insertRows.map((r) => ({
        id: r.id ?? cryptoRandomId(),
        created_at: r.created_at ?? new Date().toISOString(),
        updated_at: r.updated_at ?? new Date().toISOString(),
        resolved: r.resolved ?? false,
        resolved_by: r.resolved_by ?? null,
        resolved_at: r.resolved_at ?? null,
        anchor_x: r.anchor_x ?? null,
        anchor_y: r.anchor_y ?? null,
        mentions: r.mentions ?? [],
        ...r,
      }));
      table.push(...inserted);
      if (this.wantSingle || this.wantMaybeSingle) {
        return { data: inserted[0] ?? null, error: null };
      }
      return { data: inserted, error: null };
    }

    if (this.op === "update") {
      const matches = table.filter((row) => this.matchRow(row));
      for (const row of matches) {
        Object.assign(row, this.updateValues);
      }
      if (this.wantSingle || this.wantMaybeSingle) {
        return { data: matches[0] ?? null, error: null };
      }
      return { data: matches, error: null };
    }

    let rows = table.filter((row) => this.matchRow(row));
    if (this.orderColumn) {
      const col = this.orderColumn;
      const asc = this.orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        if (av === undefined || av === null) return asc ? -1 : 1;
        if (bv === undefined || bv === null) return asc ? 1 : -1;
        return asc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);

    if (this.wantSingle) {
      return { data: rows[0] ?? null, error: rows.length === 0 ? { message: "no rows" } : null };
    }
    if (this.wantMaybeSingle) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

let idCounter = 0;
function cryptoRandomId(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

const mockSupabase = {
  from: (table: string) => new QueryBuilder(table),
};

function resetDb() {
  for (const key of Object.keys(fakeDb)) {
    delete fakeDb[key];
  }
  idCounter = 0;
}

describe("MCP dispatcher", () => {
  it("returns server info on initialize", async () => {
    const out = await dispatchMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ctx,
    );
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    const result = out.body.result as { serverInfo: { name: string }; protocolVersion: string };
    expect(result.serverInfo.name).toBe("canvas");
    expect(result.protocolVersion).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("returns an empty result on ping", async () => {
    const out = await dispatchMcp(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      ctx,
    );
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    expect(out.body.result).toEqual({});
  });

  it("lists every advertised tool", async () => {
    const out = await dispatchMcp(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      ctx,
    );
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    const result = out.body.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name).sort()).toEqual(
      toolDescriptors.map((t) => t.name).sort(),
    );
    // Every advertised tool must have a handler.
    for (const desc of toolDescriptors) {
      expect(tools[desc.name], `handler missing for ${desc.name}`).toBeTypeOf("function");
    }
  });

  it("swallows notifications (no response body)", async () => {
    const out = await dispatchMcp(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ctx,
    );
    expect(out.kind).toBe("notification");
  });

  it("returns -32601 for unknown methods (when not a notification)", async () => {
    const out = await dispatchMcp(
      { jsonrpc: "2.0", id: 99, method: "totally/made/up" },
      ctx,
    );
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    expect(out.body.error?.code).toBe(-32601);
  });

  it("returns -32600 on malformed envelopes", async () => {
    const out = await dispatchMcp({ notJsonRpc: true }, ctx);
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    expect(out.body.error?.code).toBe(-32600);
  });

  it("rejects tools/call with an unknown tool name", async () => {
    const out = await dispatchMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "does_not_exist", arguments: {} },
      },
      ctx,
    );
    expect(out.kind).toBe("response");
    if (out.kind !== "response") throw new Error("unreachable");
    expect(out.body.error?.code).toBe(-32602);
  });
});

describe("ensureSlideSectionWrap", () => {
  it("wraps bare markup in <section class=\"slide\">", () => {
    expect(ensureSlideSectionWrap("<h1>Hello</h1>")).toBe(
      '<section class="slide"><h1>Hello</h1></section>',
    );
  });

  it("leaves an existing <section> wrapper untouched", () => {
    const html = '<section class="slide cover"><h1>Hi</h1></section>';
    expect(ensureSlideSectionWrap(html)).toBe(html);
  });

  it("tolerates leading whitespace before <section>", () => {
    const html = '\n  <section class="slide"><h1>Hi</h1></section>';
    expect(ensureSlideSectionWrap(html)).toBe(html);
  });

  it("is case-insensitive on the section tag", () => {
    const html = "<SECTION class=\"slide\"><h1>Hi</h1></SECTION>";
    expect(ensureSlideSectionWrap(html)).toBe(html);
  });
});

describe("projects", () => {
  const PROJECT_ID = "proj-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  beforeEach(() => {
    resetDb();
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_project = [
      {
        id: PROJECT_ID,
        workspace_id: ctx.workspace_id,
        name: "Acme proposal",
        description: null,
      },
    ];
    fakeDb.canvas_deck = [
      { id: "deck-1", workspace_id: ctx.workspace_id, title: "Deck 1", project_id: PROJECT_ID, updated_at: "2026-06-02" },
      { id: "deck-2", workspace_id: ctx.workspace_id, title: "Deck 2", project_id: PROJECT_ID, updated_at: "2026-06-03" },
      { id: "deck-3", workspace_id: ctx.workspace_id, title: "Deck 3", project_id: null, updated_at: "2026-06-01" },
      // Private deck in the project that the (non-admin) caller has NO
      // canvas_deck_member grant on — must stay invisible to counts/lists.
      {
        id: "deck-4",
        workspace_id: ctx.workspace_id,
        title: "Deck 4",
        project_id: PROJECT_ID,
        visibility: "private",
        updated_at: "2026-06-04",
      },
    ];
    fakeDb.canvas_deck_member = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("list_projects returns projects with deck counts, excluding private decks the caller can't see", async () => {
    const result = (await tools.list_projects({}, ctx)) as {
      projects: Array<{ id: string; name: string; deck_count: number }>;
    };
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].name).toBe("Acme proposal");
    // deck-4 is private with no grant for the caller — counting it would
    // leak its existence (deck_count 3 vs list_decks returning 2).
    expect(result.projects[0].deck_count).toBe(2);
  });

  it("list_projects counts private decks for the user holding a grant", async () => {
    fakeDb.canvas_deck_member = [{ deck_id: "deck-4", user_id: ctx.user_id }];
    const result = (await tools.list_projects({}, ctx)) as {
      projects: Array<{ deck_count: number }>;
    };
    expect(result.projects[0].deck_count).toBe(3);
  });

  it("list_projects rejects guests", async () => {
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "guest" },
    ];
    await expect(tools.list_projects({}, ctx)).rejects.toThrow(/guest/i);
  });

  it("create_project inserts a workspace-scoped row", async () => {
    const result = (await tools.create_project(
      { name: "  Paty redesign  " },
      ctx,
    )) as { project_id: string; name: string; already_existed: boolean };
    expect(result.name).toBe("Paty redesign");
    expect(result.already_existed).toBe(false);
    const row = fakeDb.canvas_project.find((p) => p.id === result.project_id);
    expect(row).toMatchObject({
      workspace_id: ctx.workspace_id,
      name: "Paty redesign",
      created_by: ctx.user_id,
    });
  });

  it("list_decks filters by project_id and includes it in rows", async () => {
    const all = (await tools.list_decks({}, ctx)) as {
      decks: Array<{ id: string; project_id: string | null }>;
    };
    expect(all.decks.map((d) => d.project_id).filter(Boolean)).toHaveLength(2);

    const filtered = (await tools.list_decks({ project_id: PROJECT_ID }, ctx)) as {
      decks: Array<{ id: string }>;
    };
    expect(filtered.decks.map((d) => d.id).sort()).toEqual(["deck-1", "deck-2"]);
  });

  it("list_decks rejects a project from another workspace", async () => {
    fakeDb.canvas_project.push({
      id: "proj-other",
      workspace_id: "another-workspace",
      name: "Elsewhere",
    });
    await expect(
      tools.list_decks({ project_id: "proj-other" }, ctx),
    ).rejects.toThrow(/not found in this workspace/);
  });

  it("list_decks hides archived decks by default, includes them with include_archived", async () => {
    // An archived deck in the workspace (workspace-visible, so not dropped for
    // any private-access reason — the only thing hiding it is archived_at).
    fakeDb.canvas_deck.push({
      id: "deck-archived",
      workspace_id: ctx.workspace_id,
      title: "Shelved deck",
      project_id: null,
      visibility: "workspace",
      updated_at: "2026-06-05",
      archived_at: "2026-06-06T00:00:00.000Z",
    });

    const def = (await tools.list_decks({}, ctx)) as {
      decks: Array<{ id: string; archived_at: string | null }>;
    };
    expect(def.decks.map((d) => d.id)).not.toContain("deck-archived");

    const withArchived = (await tools.list_decks(
      { include_archived: true },
      ctx,
    )) as { decks: Array<{ id: string; archived_at: string | null }> };
    const shelved = withArchived.decks.find((d) => d.id === "deck-archived");
    expect(shelved).toBeTruthy();
    expect(shelved?.archived_at).toBe("2026-06-06T00:00:00.000Z");
    // Active rows still carry the column, as null.
    const active = withArchived.decks.find((d) => d.id === "deck-1");
    expect(active?.archived_at ?? null).toBeNull();
  });

  it("list_projects deck_count excludes archived decks", async () => {
    // deck-1 and deck-2 are in PROJECT_ID and visible → count 2. Archive one;
    // the count must drop to 1, matching the /canvases active-only grouping.
    const target = fakeDb.canvas_deck.find((d) => d.id === "deck-2");
    if (target) target.archived_at = "2026-06-06T00:00:00.000Z";
    const result = (await tools.list_projects({}, ctx)) as {
      projects: Array<{ deck_count: number }>;
    };
    expect(result.projects[0].deck_count).toBe(1);
  });

  it("list_decks rejects a non-boolean include_archived instead of silently coercing it", async () => {
    // A stringified boolean is a known tool-calling failure mode; coercing it to
    // false would return the active-only set with no error. Fail loud instead.
    await expect(
      tools.list_decks({ include_archived: "true" }, ctx),
    ).rejects.toThrow(/include_archived must be a boolean/);
  });

  it("get_deck returns archived_at and still opens an archived deck (access-preserving)", async () => {
    const target = fakeDb.canvas_deck.find((d) => d.id === "deck-1");
    if (target) target.archived_at = "2026-06-06T00:00:00.000Z";
    const result = (await tools.get_deck({ deck_id: "deck-1" }, ctx)) as {
      deck: { id: string; archived_at: string | null };
    };
    // Archiving does not gate reads — the deck still resolves — and the marker
    // rides through so the editor can render its "Archived" chip.
    expect(result.deck.id).toBe("deck-1");
    expect(result.deck.archived_at).toBe("2026-06-06T00:00:00.000Z");
  });

  it("create_deck rejects an unknown project_id before creating anything", async () => {
    await expect(
      tools.create_deck({ title: "T", project_id: "proj-missing" }, ctx),
    ).rejects.toThrow(/not found in this workspace/);
    // No deck row was minted.
    expect(fakeDb.canvas_deck).toHaveLength(4);
  });

  it("create_deck rejects guests — web parity with the 0025 INSERT policy", async () => {
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "guest" },
    ];
    await expect(tools.create_deck({ title: "T" }, ctx)).rejects.toThrow(
      /guest/i,
    );
    expect(fakeDb.canvas_deck).toHaveLength(4);
  });
});

describe("comments", () => {
  const DECK_ID = "deck-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const SLIDE_ID = "slid-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const OTHER_DECK_ID = "deck-cccccccc-cccc-cccc-cccc-cccccccccccc";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, title: "Deck A" },
      { id: OTHER_DECK_ID, workspace_id: ctx.workspace_id, title: "Deck B" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "Slide 1",
        html_body: "",
        slide_styles: "",
        owner_id: null,
        current_version_id: null,
      },
    ];
    fakeDb.canvas_comment = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("list_comments returns roots with replies grouped under each root", async () => {
    const ROOT_A = "root-aaaaaaaa-0000-0000-0000-000000000001";
    const ROOT_B = "root-bbbbbbbb-0000-0000-0000-000000000002";
    fakeDb.canvas_comment = [
      {
        id: ROOT_A,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "deck thread A",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: ROOT_B,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        parent_id: null,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "slide thread B",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-02T00:00:00.000Z",
        updated_at: "2025-01-02T00:00:00.000Z",
      },
      {
        id: "reply-a-0000-0000-0000-000000000003",
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: ROOT_A,
        author_kind: "claude",
        author_id: ctx.user_id,
        body: "reply under A",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-03T00:00:00.000Z",
        updated_at: "2025-01-03T00:00:00.000Z",
      },
    ];

    const result = (await tools.list_comments({ deck_id: DECK_ID }, ctx)) as {
      comments: Array<{ id: string; replies: Array<{ id: string }> }>;
    };

    expect(result.comments).toHaveLength(2);
    expect(result.comments.map((c) => c.id)).toEqual([ROOT_A, ROOT_B]);
    expect(result.comments[0].replies).toHaveLength(1);
    expect(result.comments[0].replies[0].id).toBe("reply-a-0000-0000-0000-000000000003");
    expect(result.comments[1].replies).toHaveLength(0);
  });

  it("list_comments excludes resolved threads by default and includes them when flagged", async () => {
    fakeDb.canvas_comment = [
      {
        id: "root-open-0000-0000-0000-000000000001",
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "still open",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "root-done-0000-0000-0000-000000000002",
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "already resolved",
        mentions: [],
        resolved: true,
        resolved_by: ctx.user_id,
        resolved_at: "2025-01-02T00:00:00.000Z",
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-02T00:00:00.000Z",
        updated_at: "2025-01-02T00:00:00.000Z",
      },
    ];

    const defaultResult = (await tools.list_comments({ deck_id: DECK_ID }, ctx)) as {
      comments: Array<{ id: string }>;
    };
    expect(defaultResult.comments.map((c) => c.id)).toEqual([
      "root-open-0000-0000-0000-000000000001",
    ]);

    const fullResult = (await tools.list_comments(
      { deck_id: DECK_ID, include_resolved: true },
      ctx,
    )) as { comments: Array<{ id: string }> };
    expect(fullResult.comments.map((c) => c.id).sort()).toEqual([
      "root-done-0000-0000-0000-000000000002",
      "root-open-0000-0000-0000-000000000001",
    ]);
  });

  it("add_comment rejects anchors without a slide_id", async () => {
    await expect(
      tools.add_comment(
        { deck_id: DECK_ID, body: "hello", anchor_x: 0.5, anchor_y: 0.5 },
        ctx,
      ),
    ).rejects.toThrow(/anchors require slide_id/);
  });

  it("add_comment rejects a half-set anchor (only x or only y)", async () => {
    await expect(
      tools.add_comment(
        { deck_id: DECK_ID, slide_id: SLIDE_ID, body: "hello", anchor_x: 0.5 },
        ctx,
      ),
    ).rejects.toThrow(/anchor_x and anchor_y must be provided together/);

    await expect(
      tools.add_comment(
        { deck_id: DECK_ID, slide_id: SLIDE_ID, body: "hello", anchor_y: 0.5 },
        ctx,
      ),
    ).rejects.toThrow(/anchor_x and anchor_y must be provided together/);
  });

  it("add_comment accepts a slide-anchored thread with both coordinates set", async () => {
    const result = (await tools.add_comment(
      {
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        body: "  pinned  ",
        anchor_x: 0.25,
        anchor_y: 0.75,
      },
      ctx,
    )) as { comment_id: string; deck_id: string; slide_id: string };

    expect(result.deck_id).toBe(DECK_ID);
    expect(result.slide_id).toBe(SLIDE_ID);
    const inserted = fakeDb.canvas_comment.find((row) => row.id === result.comment_id);
    expect(inserted).toBeDefined();
    expect(inserted?.body).toBe("pinned");
    expect(inserted?.anchor_x).toBe(0.25);
    expect(inserted?.anchor_y).toBe(0.75);
    expect(inserted?.author_kind).toBe("claude");
    expect(inserted?.author_id).toBe(ctx.user_id);
    expect(inserted?.parent_id).toBeNull();
  });

  it("reply_to_comment rejects when the parent is itself a reply", async () => {
    const ROOT = "root-rrrr-0000-0000-0000-000000000001";
    const REPLY = "reply-rrrr-0000-0000-0000-000000000002";
    fakeDb.canvas_comment = [
      {
        id: ROOT,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "root",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: REPLY,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: ROOT,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "first reply",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-02T00:00:00.000Z",
        updated_at: "2025-01-02T00:00:00.000Z",
      },
    ];

    await expect(
      tools.reply_to_comment({ parent_id: REPLY, body: "no nesting" }, ctx),
    ).rejects.toThrow(/replies are one level deep/);
  });

  it("reply_to_comment rejects a parent on an inaccessible private deck", async () => {
    const ROOT = "root-private-0000-0000-0000-000000000001";
    fakeDb.canvas_deck = fakeDb.canvas_deck.map((row) =>
      row.id === OTHER_DECK_ID ? { ...row, visibility: "private" } : row,
    );
    fakeDb.canvas_comment = [
      {
        id: ROOT,
        workspace_id: ctx.workspace_id,
        deck_id: OTHER_DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: "someone-else",
        body: "private root",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ];

    await expect(
      tools.reply_to_comment({ parent_id: ROOT, body: "should not land" }, ctx),
    ).rejects.toThrow(/not accessible/);
    expect(fakeDb.canvas_comment).toHaveLength(1);
  });

  it("resolve_comment rejects when the target is a reply, not a root", async () => {
    const ROOT = "root-zzz-0000-0000-0000-000000000001";
    const REPLY = "reply-zzz-0000-0000-0000-000000000002";
    fakeDb.canvas_comment = [
      {
        id: ROOT,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "root",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: REPLY,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        parent_id: ROOT,
        author_kind: "user",
        author_id: ctx.user_id,
        body: "a reply",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-02T00:00:00.000Z",
        updated_at: "2025-01-02T00:00:00.000Z",
      },
    ];

    await expect(tools.resolve_comment({ comment_id: REPLY }, ctx)).rejects.toThrow(
      /only thread roots can be resolved/,
    );
  });

  it("resolve_comment rejects a thread on an inaccessible private deck", async () => {
    const ROOT = "root-private-0000-0000-0000-000000000002";
    fakeDb.canvas_deck = fakeDb.canvas_deck.map((row) =>
      row.id === OTHER_DECK_ID ? { ...row, visibility: "private" } : row,
    );
    fakeDb.canvas_comment = [
      {
        id: ROOT,
        workspace_id: ctx.workspace_id,
        deck_id: OTHER_DECK_ID,
        slide_id: null,
        parent_id: null,
        author_kind: "user",
        author_id: "someone-else",
        body: "private root",
        mentions: [],
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        anchor_x: null,
        anchor_y: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ];

    await expect(tools.resolve_comment({ comment_id: ROOT }, ctx)).rejects.toThrow(
      /not accessible/,
    );
    expect(fakeDb.canvas_comment[0].resolved).toBe(false);
  });
});

describe("propose_deck_edit", () => {
  const DECK_ID = "deck-00000000-0000-0000-0000-000000000010";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, title: "Original Deck Title" },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("inserts a deck_title proposal, captures base_deck_title, and returns the edit id", async () => {
    const result = (await tools.propose_deck_edit(
      {
        deck_id: DECK_ID,
        new_title: "  Flow Test Deck 2  ",
        rationale: "Renaming for the upcoming flow test.",
      },
      ctx,
    )) as {
      edit_id: string;
      deck_id: string;
      kind: string;
      status: string;
      created_at: string;
    };

    expect(result.kind).toBe("deck_title");
    expect(result.status).toBe("pending");
    expect(result.deck_id).toBe(DECK_ID);
    expect(result.edit_id).toBeTypeOf("string");

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    // Title is trimmed at propose time so we don't store leading/trailing
    // whitespace the apply path would reject anyway.
    expect(row.new_content).toBe("Flow Test Deck 2");
    expect(row.base_deck_title).toBe("Original Deck Title");
    expect(row.kind).toBe("deck_title");
    expect(row.slide_id).toBeNull();
    expect(row.proposed_by_kind).toBe("claude");
    expect(row.workspace_id).toBe(ctx.workspace_id);
  });

  it("throws when new_title is missing", async () => {
    await expect(
      tools.propose_deck_edit({ deck_id: DECK_ID }, ctx),
    ).rejects.toThrow(/propose_deck_edit requires one of: new_title/);
    expect(fakeDb.canvas_deck_edit ?? []).toHaveLength(0);
  });

  it("throws when new_title is empty after trim", async () => {
    await expect(
      tools.propose_deck_edit(
        { deck_id: DECK_ID, new_title: "   \n\t  " },
        ctx,
      ),
    ).rejects.toThrow(/new_title cannot be empty/);
    expect(fakeDb.canvas_deck_edit ?? []).toHaveLength(0);
  });

  it("throws when the deck is not in the caller's workspace", async () => {
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: "00000000-0000-0000-0000-0000000000ff", title: "Other" },
    ];
    await expect(
      tools.propose_deck_edit(
        { deck_id: DECK_ID, new_title: "New Title" },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
    expect(fakeDb.canvas_deck_edit ?? []).toHaveLength(0);
  });
});

describe("propose_slide_edit (bundled slide_edit)", () => {
  const DECK_ID = "deck-st00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-st00-0000-0000-0000-000000000002";
  const BASE_VERSION = "vers-st00-0000-0000-0000-00000000003";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      {
        id: DECK_ID,
        workspace_id: ctx.workspace_id,
        visibility: "workspace",
        title: "Pitch",
      },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 2,
        title: "Abordagem",
        html_body: "<section class=\"slide\"><h1>Como funciona</h1></section>",
        slide_styles: "",
        owner_id: null,
        current_version_id: BASE_VERSION,
      },
    ];
    // The slide's current version row — propose_slide_edit resolves
    // current_version_id to this version_no to validate base_version_no.
    fakeDb.canvas_slide_version = [
      { id: BASE_VERSION, slide_id: SLIDE_ID, version_no: 7 },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("inserts a single-field slide_edit carrying the trimmed label in the payload and the slide's base version", async () => {
    const result = (await tools.propose_slide_edit(
      {
        slide_id: SLIDE_ID,
        base_version_no: 7,
        new_title: "  Como funciona  ",
        rationale: "Slide content is now the how-it-works section.",
      },
      ctx,
    )) as {
      edit_id: string;
      slide_id: string;
      kind: string;
      fields: string[];
      status: string;
      base_version_id: string | null;
    };

    // Every slide edit is now the bundled 'slide_edit' kind, even single-field
    // ones — the payload carries only the touched fields.
    expect(result.kind).toBe("slide_edit");
    expect(result.fields).toEqual(["title"]);
    expect(result.status).toBe("pending");
    expect(result.slide_id).toBe(SLIDE_ID);
    // Carries the slide's current version so the reviewer's stale-base check
    // works for the bundled edit too.
    expect(result.base_version_id).toBe(BASE_VERSION);

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_edit");
    expect(row.slide_id).toBe(SLIDE_ID);
    expect(row.base_version_id).toBe(BASE_VERSION);
    expect(row.proposed_by_kind).toBe("claude");
    expect(row.workspace_id).toBe(ctx.workspace_id);
    // slide_edit rides new_slide_payload, not the text new_content column.
    expect(row.new_content ?? null).toBeNull();
    expect(row.new_slide_payload).toEqual({ title: "Como funciona" });
  });

  it("returns suggested_patch (the exact propose_slide_patch) when a full edit barely changes a multi-line slide", async () => {
    // Multi-line body so a one-line change lands under the patch-nudge ratio
    // (a single-line slide always reads as a 100% change and earns no nudge).
    const inner = Array.from({ length: 12 }, (_, i) => `  <p>row ${i}</p>`).join("\n");
    const before = `<section class="slide">\n${inner}\n</section>`;
    fakeDb.canvas_deck_slide[0].html_body = before;
    const after = before.replace("<p>row 5</p>", "<p>row five</p>");

    const result = (await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 7, new_html_body: after, rationale: "tweak one line" },
      ctx,
    )) as {
      hint?: string;
      suggested_patch?: { find: string; replace: string; in?: string }[];
    };

    expect(result.suggested_patch).toBeDefined();
    expect(result.suggested_patch).toHaveLength(1);
    expect(result.suggested_patch![0].find).toContain("row 5");
    expect(result.suggested_patch![0].replace).toContain("row five");
    // html_body edits omit `in` (it's the default field).
    expect(result.suggested_patch![0].in).toBeUndefined();
    expect(String(result.hint)).toMatch(/suggested_patch/);
  });

  it("does NOT suggest a patch for a genuine redesign (most lines change)", async () => {
    const inner = Array.from({ length: 12 }, (_, i) => `  <p>row ${i}</p>`).join("\n");
    fakeDb.canvas_deck_slide[0].html_body = `<section class="slide">\n${inner}\n</section>`;
    const rewritten = Array.from({ length: 12 }, (_, i) => `  <h2>heading ${i}</h2>`).join("\n");
    const after = `<section class="slide">\n${rewritten}\n</section>`;

    const result = (await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 7, new_html_body: after, rationale: "redesign" },
      ctx,
    )) as { hint?: string; suggested_patch?: unknown };

    expect(result.suggested_patch).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it("falls back to a prose hint (no suggested_patch) when a small change is un-patchable", async () => {
    // 21 identical lines: the one changed MIDDLE line can't be uniquely anchored,
    // so computeSlidePatch returns null even though the change is tiny (ratio
    // well under the nudge threshold) → the result carries the prose hint but no
    // suggested_patch. Exercises the integration `else` branch.
    const lines = Array.from({ length: 21 }, () => "  <p>x</p>");
    const before = `<section class="slide">\n${lines.join("\n")}\n</section>`;
    fakeDb.canvas_deck_slide[0].html_body = before;
    const afterLines = [...lines];
    afterLines[10] = "  <p>y</p>";
    const after = `<section class="slide">\n${afterLines.join("\n")}\n</section>`;

    const result = (await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 7, new_html_body: after, rationale: "tiny tweak" },
      ctx,
    )) as { hint?: string; suggested_patch?: unknown };

    expect(result.suggested_patch).toBeUndefined();
    expect(String(result.hint)).toMatch(/propose_slide_patch/);
  });

  it("allows a whitespace-only title (clears the label) — stored as empty string in the payload", async () => {
    await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 7, new_title: "   \n\t " },
      ctx,
    );
    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_edit");
    expect(row.new_slide_payload).toEqual({ title: "" });
  });

  it("bundles html + css + title into ONE slide_edit proposal (html section-wrapped)", async () => {
    const result = (await tools.propose_slide_edit(
      {
        slide_id: SLIDE_ID,
        base_version_no: 7,
        new_title: "X",
        new_html_body: "<h1>y</h1>",
        new_slide_styles: ".slide{color:red}",
        rationale: "Redesign the slide.",
      },
      ctx,
    )) as { kind: string; fields: string[] };

    expect(result.kind).toBe("slide_edit");
    expect(result.fields).toEqual(["html_body", "slide_styles", "title"]);
    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_edit");
    expect(row.new_content ?? null).toBeNull();
    // Bare markup is auto-wrapped; css + title ride along untouched.
    expect(row.new_slide_payload).toEqual({
      html_body: "<section class=\"slide\"><h1>y</h1></section>",
      slide_styles: ".slide{color:red}",
      title: "X",
    });
  });

  it("rejects a call that provides no field", async () => {
    await expect(
      tools.propose_slide_edit({ slide_id: SLIDE_ID, base_version_no: 7 }, ctx),
    ).rejects.toThrow(
      /requires at least one of: new_html_body, new_slide_styles, new_title/,
    );
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  // --- base_version_no: the anti-clobber gate ------------------------------
  // A full-content replacement built from a stale read silently reverts every
  // newer version once approved (base_version_id can't catch it — it's stamped
  // server-side at insert time, so it always looks current). The caller must
  // echo the version it actually read; a mismatch is rejected with re-read
  // guidance instead of writing a proposal.

  it("rejects a call without base_version_no, telling the caller to read the slide first", async () => {
    await expect(
      tools.propose_slide_edit(
        { slide_id: SLIDE_ID, new_html_body: "<h1>built from a stale copy</h1>" },
        ctx,
      ),
    ).rejects.toThrow(/"base_version_no" is required/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects a stale base_version_no (slide moved on since the caller read it), with no row written", async () => {
    await expect(
      tools.propose_slide_edit(
        {
          slide_id: SLIDE_ID,
          base_version_no: 6,
          new_html_body: "<h1>built from version 6</h1>",
        },
        ctx,
      ),
    ).rejects.toThrow(/at version 7[\s\S]*built from version 6/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("skips the version check when the slide has no current version row to revert", async () => {
    // No history → nothing a stale rewrite could clobber. Covers both a null
    // current_version_id and a dangling pointer with no version row behind it.
    fakeDb.canvas_deck_slide[0].current_version_id = null;
    await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 1, new_title: "fresh slide" },
      ctx,
    );
    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
  });
});

// read_full_deck must hand back per-slide ids + version numbers alongside the
// assembled HTML — a caller that only did a deck-wide read still needs both to
// propose_slide_edit afterwards (slide_id + required base_version_no) without
// a per-slide read round-trip.
describe("read_full_deck (slide metadata for follow-up edits)", () => {
  const DECK_ID = "deck-fd00-0000-0000-0000-000000000001";
  const S1 = "slid-fd00-0000-0000-0000-000000000011";
  const S2 = "slid-fd00-0000-0000-0000-000000000012";
  const V1 = "vers-fd00-0000-0000-0000-000000000021";

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
    fakeDb.canvas_deck_slide = [
      {
        id: S1,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "Capa",
        html_body: '<section class="slide"><h1>a</h1></section>',
        slide_styles: "",
        owner_id: null,
        current_version_id: V1,
      },
      {
        id: S2,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 1,
        title: "Resumo",
        html_body: '<section class="slide"><h1>b</h1></section>',
        slide_styles: "",
        owner_id: null,
        current_version_id: null,
      },
    ];
    fakeDb.canvas_slide_version = [{ id: V1, slide_id: S1, version_no: 4 }];
  });

  afterEach(() => {
    resetDb();
  });

  it("returns the assembled html plus slide_id/position/title/current_version_no per slide", async () => {
    const result = (await tools.read_full_deck({ deck_id: DECK_ID }, ctx)) as {
      html: string;
      slides: Array<{
        slide_id: string;
        position: number;
        title: string;
        current_version_no: number | null;
      }>;
    };
    expect(result.html).toContain("<h1>a</h1>");
    expect(result.html).toContain("<h1>b</h1>");
    expect(result.slides).toEqual([
      { slide_id: S1, position: 0, title: "Capa", current_version_no: 4 },
      { slide_id: S2, position: 1, title: "Resumo", current_version_no: null },
    ]);
  });
});

// Sources are the human's pinned reference material (canvas_deck_source). The
// two read tools are workspace-scoped on the admin client and gated per-deck
// exactly like read_slide — these tests pin the scoping (deck filter, the
// global-vs-slide narrowing, the private-deck gate) and the return shape
// (body preview on the list, full body + binary note on the read).
describe("sources (list_sources / read_source)", () => {
  const DECK_ID = "deck-sr00-0000-0000-0000-000000000001";
  const OTHER_DECK_ID = "deck-sr00-0000-0000-0000-000000000002";
  const SLIDE_ID = "slid-sr00-0000-0000-0000-000000000003";
  const OTHER_SLIDE_ID = "slid-sr00-0000-0000-0000-000000000004";
  const DECK_SRC = "src0-sr00-0000-0000-0000-000000000010";
  const SLIDE_SRC = "src0-sr00-0000-0000-0000-000000000011";
  const OTHER_SLIDE_SRC = "src0-sr00-0000-0000-0000-000000000012";
  const URL_SRC = "src0-sr00-0000-0000-0000-000000000013";
  const PDF_SRC = "src0-sr00-0000-0000-0000-000000000014";
  const OTHER_DECK_SRC = "src0-sr00-0000-0000-0000-000000000015";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Deck" },
      { id: OTHER_DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Other" },
    ];
    fakeDb.canvas_deck_source = [
      // Deck-global pasted text.
      {
        id: DECK_SRC,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        kind: "text",
        label: "Brief",
        url: null,
        storage_path: null,
        body: "Line one.\nLine two with   extra spaces.",
        created_at: "2026-06-01T00:00:00.000Z",
      },
      // Pinned to SLIDE_ID.
      {
        id: SLIDE_SRC,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        kind: "text",
        label: "Slide note",
        url: null,
        storage_path: null,
        body: "Just this slide.",
        created_at: "2026-06-02T00:00:00.000Z",
      },
      // Pinned to a DIFFERENT slide — must NOT appear when scoping to SLIDE_ID.
      {
        id: OTHER_SLIDE_SRC,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: OTHER_SLIDE_ID,
        kind: "text",
        label: "Other slide note",
        url: null,
        storage_path: null,
        body: "Different slide.",
        created_at: "2026-06-03T00:00:00.000Z",
      },
      // Deck-global URL source — no body.
      {
        id: URL_SRC,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        kind: "url",
        label: "Reference page",
        url: "https://example.com/ref",
        storage_path: null,
        body: null,
        created_at: "2026-06-04T00:00:00.000Z",
      },
      // Deck-global PDF source — binary, lives at a storage_path.
      {
        id: PDF_SRC,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: null,
        kind: "pdf",
        label: "Spec.pdf",
        url: null,
        storage_path: "sources/spec.pdf",
        body: null,
        created_at: "2026-06-05T00:00:00.000Z",
      },
      // Belongs to a different deck — must never leak into DECK_ID's list.
      {
        id: OTHER_DECK_SRC,
        workspace_id: ctx.workspace_id,
        deck_id: OTHER_DECK_ID,
        slide_id: null,
        kind: "text",
        label: "Other deck brief",
        url: null,
        storage_path: null,
        body: "Not this deck.",
        created_at: "2026-06-06T00:00:00.000Z",
      },
    ];
  });

  afterEach(() => {
    resetDb();
  });

  it("list_sources returns only this deck's sources, with a collapsed body preview and binary flag", async () => {
    const result = (await tools.list_sources({ deck_id: DECK_ID }, ctx)) as {
      sources: Array<{
        id: string;
        kind: string;
        has_body: boolean;
        body_preview: string | null;
        is_binary: boolean;
      }>;
    };
    // Five sources on DECK_ID; the OTHER_DECK_ID source is excluded.
    expect(result.sources.map((s) => s.id).sort()).toEqual(
      [DECK_SRC, SLIDE_SRC, OTHER_SLIDE_SRC, URL_SRC, PDF_SRC].sort(),
    );
    const brief = result.sources.find((s) => s.id === DECK_SRC)!;
    expect(brief.has_body).toBe(true);
    // Newlines + runs of spaces collapse to single spaces in the preview.
    expect(brief.body_preview).toBe("Line one. Line two with extra spaces.");
    expect(brief.is_binary).toBe(false);
    // URL source has no body; PDF source is flagged binary.
    expect(result.sources.find((s) => s.id === URL_SRC)!.has_body).toBe(false);
    expect(result.sources.find((s) => s.id === PDF_SRC)!.is_binary).toBe(true);
  });

  it("list_sources with slide_id returns deck-global + that slide's sources only", async () => {
    const result = (await tools.list_sources(
      { deck_id: DECK_ID, slide_id: SLIDE_ID },
      ctx,
    )) as { sources: Array<{ id: string }> };
    // Deck-global (DECK_SRC, URL_SRC, PDF_SRC) + SLIDE_ID's own (SLIDE_SRC);
    // OTHER_SLIDE_SRC is pinned to a different slide and excluded.
    expect(result.sources.map((s) => s.id).sort()).toEqual(
      [DECK_SRC, SLIDE_SRC, URL_SRC, PDF_SRC].sort(),
    );
  });

  it("read_source returns one source's full body and kind/label/url", async () => {
    const result = (await tools.read_source({ source_id: DECK_SRC }, ctx)) as {
      id: string;
      kind: string;
      label: string;
      body: string | null;
      note?: string;
    };
    expect(result.id).toBe(DECK_SRC);
    expect(result.kind).toBe("text");
    expect(result.label).toBe("Brief");
    // Full body comes back verbatim (not the collapsed preview).
    expect(result.body).toBe("Line one.\nLine two with   extra spaces.");
    expect(result.note).toBeUndefined();
  });

  it("read_source notes a binary source instead of returning its bytes", async () => {
    const result = (await tools.read_source({ source_id: PDF_SRC }, ctx)) as {
      kind: string;
      storage_path: string | null;
      body: string | null;
      note?: string;
    };
    expect(result.kind).toBe("pdf");
    expect(result.storage_path).toBe("sources/spec.pdf");
    expect(result.body).toBeNull();
    expect(result.note).toMatch(/binary/i);
  });

  it("read_source rejects a source in another workspace", async () => {
    fakeDb.canvas_deck_source.push({
      id: "src0-sr00-0000-0000-0000-0000000000ff",
      workspace_id: "00000000-0000-0000-0000-0000000000ff",
      deck_id: "deck-elsewhere",
      slide_id: null,
      kind: "text",
      label: "Foreign",
      url: null,
      storage_path: null,
      body: "secret",
      created_at: "2026-06-07T00:00:00.000Z",
    });
    await expect(
      tools.read_source({ source_id: "src0-sr00-0000-0000-0000-0000000000ff" }, ctx),
    ).rejects.toThrow(/not found in this workspace/);
  });

  it("list_sources blocks a member not invited to a private deck", async () => {
    fakeDb.canvas_deck = fakeDb.canvas_deck.map((row) =>
      row.id === DECK_ID ? { ...row, visibility: "private" } : row,
    );
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_deck_member = [];
    await expect(
      tools.list_sources({ deck_id: DECK_ID }, ctx),
    ).rejects.toThrow(/not accessible/);
  });

  it("read_source blocks a member not invited to the source's private deck", async () => {
    fakeDb.canvas_deck = fakeDb.canvas_deck.map((row) =>
      row.id === DECK_ID ? { ...row, visibility: "private" } : row,
    );
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_deck_member = [];
    await expect(
      tools.read_source({ source_id: DECK_SRC }, ctx),
    ).rejects.toThrow(/not accessible/);
  });
});

// propose_slide_patch resolves find/replace snippets server-side and persists
// the SAME kind='slide_edit' row propose_slide_edit would — these tests pin
// that wiring (resolution against stored content, touched-fields-only payload,
// base version pointer), not the patch engine itself (slide-patch.test.ts).
describe("propose_slide_patch (server-side find/replace)", () => {
  const DECK_ID = "deck-pt00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-pt00-0000-0000-0000-000000000002";
  const BASE_VERSION = "vers-pt00-0000-0000-0000-00000000003";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      {
        id: DECK_ID,
        workspace_id: ctx.workspace_id,
        visibility: "workspace",
        title: "Pitch",
      },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 2,
        title: "Abordagem",
        html_body: "<section class=\"slide\"><h1>Como funciona</h1><p>R$ 1.2M</p></section>",
        slide_styles: ".slide h1 { color: red; }",
        owner_id: null,
        current_version_id: BASE_VERSION,
      },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("resolves edits against stored content and inserts a normal slide_edit with only the touched field", async () => {
    const result = (await tools.propose_slide_patch(
      {
        slide_id: SLIDE_ID,
        edits: [{ find: "R$ 1.2M", replace: "R$ 1.4M" }],
        rationale: "Updated revenue figure.",
      },
      ctx,
    )) as {
      kind: string;
      fields: string[];
      edits_applied: number;
      status: string;
      base_version_id: string | null;
    };

    expect(result.kind).toBe("slide_edit");
    expect(result.fields).toEqual(["html_body"]);
    expect(result.edits_applied).toBe(1);
    expect(result.status).toBe("pending");
    expect(result.base_version_id).toBe(BASE_VERSION);

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_edit");
    expect(row.proposed_by_kind).toBe("claude");
    expect(row.base_version_id).toBe(BASE_VERSION);
    expect(row.new_content ?? null).toBeNull();
    // Full resolved html_body; slide_styles untouched so it's omitted (keeps
    // current value on apply, same as propose_slide_edit's omitted fields).
    expect(row.new_slide_payload).toEqual({
      html_body:
        "<section class=\"slide\"><h1>Como funciona</h1><p>R$ 1.4M</p></section>",
    });
  });

  it("patches slide_styles via in:'slide_styles' without touching html_body", async () => {
    await tools.propose_slide_patch(
      {
        slide_id: SLIDE_ID,
        edits: [
          { find: "color: red", replace: "color: blue", in: "slide_styles" },
        ],
      },
      ctx,
    );
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.new_slide_payload).toEqual({
      slide_styles: ".slide h1 { color: blue; }",
    });
  });

  it("surfaces patch-engine failures as tool errors and writes no row", async () => {
    await expect(
      tools.propose_slide_patch(
        { slide_id: SLIDE_ID, edits: [{ find: "not in the slide", replace: "x" }] },
        ctx,
      ),
    ).rejects.toThrow(/not found in html_body/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  // ensureSlideSectionWrap only checks the LEADING tag, so a patch that eats
  // the opening <section> would otherwise get re-wrapped around the dangling
  // trailing </section> and persist malformed nested markup.
  it("rejects a patch that removes the opening <section> wrapper, with no row written", async () => {
    await expect(
      tools.propose_slide_patch(
        {
          slide_id: SLIDE_ID,
          edits: [{ find: '<section class="slide">', replace: "<div>" }],
        },
        ctx,
      ),
    ).rejects.toThrow(/opening <section> wrapper/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects malformed edits arrays with the offending index", async () => {
    await expect(
      tools.propose_slide_patch({ slide_id: SLIDE_ID, edits: [] }, ctx),
    ).rejects.toThrow(/non-empty array/);
    await expect(
      tools.propose_slide_patch(
        { slide_id: SLIDE_ID, edits: [{ find: "a", replace: "b" }, { find: "c" }] },
        ctx,
      ),
    ).rejects.toThrow(/edits\[1\]\.replace/);
  });
});

// Editor-role enforcement on write tools (mirrors canvas_can_edit_deck). A
// viewer of a private deck can read it but must not be able to author edits;
// an explicit 'editor' deck-member row (or admin/owner) is required to write.
describe("editor-role enforcement (private decks)", () => {
  const PRIVATE_DECK = "deck-priv-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-priv-0000-0000-0000-000000000002";
  const VIEWER = "00000000-0000-0000-0000-0000000000a1";
  const EDITOR = "00000000-0000-0000-0000-0000000000a2";
  const ADMIN = "00000000-0000-0000-0000-0000000000a3";
  const viewerCtx = { user_id: VIEWER, workspace_id: ctx.workspace_id };
  const editorCtx = { user_id: EDITOR, workspace_id: ctx.workspace_id };
  const adminCtx = { user_id: ADMIN, workspace_id: ctx.workspace_id };

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      {
        id: PRIVATE_DECK,
        workspace_id: ctx.workspace_id,
        visibility: "private",
        created_by: ADMIN,
        title: "Secret Deck",
      },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: PRIVATE_DECK,
        position: 0,
        title: "S1",
        html_body: "",
        slide_styles: "",
        owner_id: null,
        current_version_id: null,
      },
    ];
    // VIEWER is a plain member with a viewer-role deck_member row; EDITOR has an
    // editor-role row; ADMIN is a workspace admin (no deck_member row needed).
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: VIEWER, role: "member" },
      { workspace_id: ctx.workspace_id, user_id: EDITOR, role: "member" },
      { workspace_id: ctx.workspace_id, user_id: ADMIN, role: "admin" },
    ];
    fakeDb.canvas_deck_member = [
      { deck_id: PRIVATE_DECK, user_id: VIEWER, role: "viewer" },
      { deck_id: PRIVATE_DECK, user_id: EDITOR, role: "editor" },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("lets an invited viewer READ the deck", async () => {
    const result = (await tools.read_slide({ slide_id: SLIDE_ID }, viewerCtx)) as {
      id: string;
    };
    expect(result.id).toBe(SLIDE_ID);
  });

  it("blocks a viewer from proposing a slide edit", async () => {
    await expect(
      tools.propose_slide_edit(
        {
          slide_id: SLIDE_ID,
          base_version_no: 1,
          new_html_body: "<section class=\"slide\">x</section>",
        },
        viewerCtx,
      ),
    ).rejects.toThrow(/read-only for you/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  // The MCP route bypasses RLS, so assertDeckEditableByUser is the ONLY gate
  // on the patch fast path — pin it like every other write tool above.
  it("blocks a viewer from proposing a slide patch", async () => {
    await expect(
      tools.propose_slide_patch(
        { slide_id: SLIDE_ID, edits: [{ find: "a", replace: "b" }] },
        viewerCtx,
      ),
    ).rejects.toThrow(/read-only for you/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("blocks a viewer from proposing a new slide", async () => {
    await expect(
      tools.propose_new_slide(
        { deck_id: PRIVATE_DECK, position: 0, html_body: "<h1>x</h1>" },
        viewerCtx,
      ),
    ).rejects.toThrow(/read-only for you/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("blocks a viewer from proposing a theme edit", async () => {
    await expect(
      tools.propose_theme_edit(
        { deck_id: PRIVATE_DECK, new_theme_css: ".slide{}" },
        viewerCtx,
      ),
    ).rejects.toThrow(/read-only for you/);
  });

  it("blocks a viewer from proposing a deck edit", async () => {
    await expect(
      tools.propose_deck_edit(
        { deck_id: PRIVATE_DECK, new_title: "Renamed" },
        viewerCtx,
      ),
    ).rejects.toThrow(/read-only for you/);
  });

  it("blocks a viewer from locking a slide", async () => {
    await expect(
      tools.lock_slide({ slide_id: SLIDE_ID }, viewerCtx),
    ).rejects.toThrow(/read-only for you/);
  });

  it("blocks a viewer from creating a snapshot", async () => {
    await expect(
      tools.create_snapshot({ deck_id: PRIVATE_DECK, label: "v1" }, viewerCtx),
    ).rejects.toThrow(/read-only for you/);
  });

  it("lets an explicit editor propose a slide edit", async () => {
    const result = (await tools.propose_slide_edit(
      {
        slide_id: SLIDE_ID,
        base_version_no: 1,
        new_html_body: "<section class=\"slide\">y</section>",
      },
      editorCtx,
    )) as { edit_id: string; status: string };
    expect(result.status).toBe("pending");
    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
  });

  it("lets a workspace admin propose a slide edit without a deck_member row", async () => {
    const result = (await tools.propose_slide_edit(
      {
        slide_id: SLIDE_ID,
        base_version_no: 1,
        new_html_body: "<section class=\"slide\">z</section>",
      },
      adminCtx,
    )) as { status: string };
    expect(result.status).toBe("pending");
  });
});

// Private-deck gating on proposal/comment tools: a workspace member who isn't
// invited to a private deck must not read, enumerate, or comment on that deck's
// proposals.
describe("private-deck gating (proposals)", () => {
  const PRIVATE_DECK = "deck-pg00-0000-0000-0000-000000000001";
  const PUBLIC_DECK = "deck-pg01-0000-0000-0000-000000000002";
  const OUTSIDER = "00000000-0000-0000-0000-0000000000b1";
  const ADMIN_ID = "00000000-0000-0000-0000-0000000000b9";
  const outsiderCtx = { user_id: OUTSIDER, workspace_id: ctx.workspace_id };
  const PRIVATE_EDIT = "edit-pg00-0000-0000-0000-000000000010";
  const PUBLIC_EDIT = "edit-pg01-0000-0000-0000-000000000011";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: PRIVATE_DECK, workspace_id: ctx.workspace_id, visibility: "private", title: "Private" },
      { id: PUBLIC_DECK, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Public" },
    ];
    // OUTSIDER is a plain member of the workspace but has no deck_member row on
    // the private deck.
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: OUTSIDER, role: "member" },
    ];
    fakeDb.canvas_deck_member = [];
    fakeDb.canvas_deck_edit = [
      {
        id: PRIVATE_EDIT,
        workspace_id: ctx.workspace_id,
        deck_id: PRIVATE_DECK,
        slide_id: null,
        kind: "deck_title",
        proposed_by: ADMIN_ID,
        proposed_by_kind: "claude",
        new_content: "x",
        status: "pending",
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: PUBLIC_EDIT,
        workspace_id: ctx.workspace_id,
        deck_id: PUBLIC_DECK,
        slide_id: null,
        kind: "deck_title",
        proposed_by: ADMIN_ID,
        proposed_by_kind: "claude",
        new_content: "y",
        status: "pending",
        created_at: "2025-01-02T00:00:00.000Z",
      },
    ];
    fakeDb.canvas_edit_comment = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("list_proposals hides proposals on private decks the caller can't access", async () => {
    const result = (await tools.list_proposals({}, outsiderCtx)) as {
      proposals: Array<{ id: string; deck_id: string }>;
    };
    expect(result.proposals.map((p) => p.id)).toEqual([PUBLIC_EDIT]);
  });

  it("get_proposal denies reading a private-deck proposal", async () => {
    await expect(
      tools.get_proposal({ edit_id: PRIVATE_EDIT }, outsiderCtx),
    ).rejects.toThrow(/not invited/);
  });

  it("get_proposal allows reading a workspace-deck proposal", async () => {
    const result = (await tools.get_proposal({ edit_id: PUBLIC_EDIT }, outsiderCtx)) as {
      edit: { id: string };
    };
    expect(result.edit.id).toBe(PUBLIC_EDIT);
  });

  it("comment_on_proposal denies commenting on a private-deck proposal", async () => {
    await expect(
      tools.comment_on_proposal({ edit_id: PRIVATE_EDIT, body: "hi" }, outsiderCtx),
    ).rejects.toThrow(/not invited/);
    expect(fakeDb.canvas_edit_comment).toHaveLength(0);
  });

  it("withdraw_proposal denies touching a private-deck proposal", async () => {
    await expect(
      tools.withdraw_proposal({ edit_id: PRIVATE_EDIT }, outsiderCtx),
    ).rejects.toThrow(/not invited/);
  });
});

// Per-payload size caps on write tools (the route enforces a separate, larger
// cap on the whole HTTP body).
describe("payload size caps", () => {
  const DECK_ID = "deck-sz00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-sz00-0000-0000-0000-000000000002";
  const huge = "a".repeat(1_000_001);

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "D" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "S",
        html_body: "",
        slide_styles: "",
        owner_id: null,
        current_version_id: null,
      },
    ];
    fakeDb.workspace_memberships = [];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("rejects an oversized new_html_body", async () => {
    await expect(
      tools.propose_slide_edit(
        { slide_id: SLIDE_ID, base_version_no: 1, new_html_body: huge },
        ctx,
      ),
    ).rejects.toThrow(/too large/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects an oversized new_theme_css", async () => {
    await expect(
      tools.propose_theme_edit({ deck_id: DECK_ID, new_theme_css: huge }, ctx),
    ).rejects.toThrow(/too large/);
  });

  it("rejects an oversized new-slide html_body", async () => {
    await expect(
      tools.propose_new_slide({ deck_id: DECK_ID, position: 0, html_body: huge }, ctx),
    ).rejects.toThrow(/too large/);
  });
});

// Structural slide operations: reordering and deletion. These propose tools do
// all their argument/permutation validation client-side before inserting a
// pending edit; the apply RPC re-validates server-side at approve time (it
// can't be exercised here because the FakeDb harness isn't real Postgres).
describe("propose_reorder_slides", () => {
  const DECK_ID = "deck-ro00-0000-0000-0000-000000000001";
  const S1 = "slid-ro00-0000-0000-0000-000000000011";
  const S2 = "slid-ro00-0000-0000-0000-000000000012";
  const S3 = "slid-ro00-0000-0000-0000-000000000013";
  const FOREIGN = "slid-ro00-0000-0000-0000-0000000000ff";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Reorder Deck" },
    ];
    fakeDb.canvas_deck_slide = [S1, S2, S3].map((id, i) => ({
      id,
      workspace_id: ctx.workspace_id,
      deck_id: DECK_ID,
      position: i,
      title: `S${i + 1}`,
      html_body: "",
      slide_styles: "",
      owner_id: null,
      current_version_id: null,
    }));
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("rejects when order is not an array", async () => {
    await expect(
      tools.propose_reorder_slides({ deck_id: DECK_ID, order: "nope" }, ctx),
    ).rejects.toThrow(/must be a non-empty array/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects when order is an empty array", async () => {
    await expect(
      tools.propose_reorder_slides({ deck_id: DECK_ID, order: [] }, ctx),
    ).rejects.toThrow(/must be a non-empty array/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects when order contains non-string elements", async () => {
    await expect(
      tools.propose_reorder_slides({ deck_id: DECK_ID, order: [S1, 2, S3] }, ctx),
    ).rejects.toThrow(/must be a non-empty array/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects when order does not cover every slide exactly once", async () => {
    await expect(
      tools.propose_reorder_slides({ deck_id: DECK_ID, order: [S1, S2] }, ctx),
    ).rejects.toThrow(/must list all 3 slide/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects when order contains a duplicate slide id", async () => {
    await expect(
      tools.propose_reorder_slides({ deck_id: DECK_ID, order: [S1, S2, S2] }, ctx),
    ).rejects.toThrow(/duplicate slide ids/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects when order references a slide not in the deck", async () => {
    await expect(
      tools.propose_reorder_slides({ deck_id: DECK_ID, order: [S1, S2, FOREIGN] }, ctx),
    ).rejects.toThrow(/not in deck/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("inserts a slide_reorder edit for a valid permutation", async () => {
    const result = (await tools.propose_reorder_slides(
      { deck_id: DECK_ID, order: [S3, S1, S2], rationale: "tighten the flow" },
      ctx,
    )) as { kind: string; status: string; slide_count: number; deck_id: string };

    expect(result.kind).toBe("slide_reorder");
    expect(result.status).toBe("pending");
    expect(result.slide_count).toBe(3);
    expect(result.deck_id).toBe(DECK_ID);

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_reorder");
    expect(row.slide_id).toBeNull();
    expect(row.new_content).toBeNull();
    expect(row.new_slide_payload).toEqual({ order: [S3, S1, S2] });
    expect(row.status).toBe("pending");
    expect(row.proposed_by_kind).toBe("claude");
    expect(row.workspace_id).toBe(ctx.workspace_id);
  });
});

describe("propose_delete_slide", () => {
  const DECK_ID = "deck-de00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-de00-0000-0000-0000-000000000011";
  const FOREIGN_SLIDE = "slid-de00-0000-0000-0000-0000000000ff";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Delete Deck" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "S1",
        html_body: "",
        slide_styles: "",
        owner_id: null,
        current_version_id: null,
      },
    ];
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("rejects a slide that is not in the caller's workspace", async () => {
    await expect(
      tools.propose_delete_slide({ slide_id: FOREIGN_SLIDE }, ctx),
    ).rejects.toThrow(/not found in this workspace/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("inserts a slide_delete edit carrying the target slide_id", async () => {
    const result = (await tools.propose_delete_slide(
      { slide_id: SLIDE_ID, rationale: "redundant" },
      ctx,
    )) as { kind: string; status: string; slide_id: string; deck_id: string };

    expect(result.kind).toBe("slide_delete");
    expect(result.status).toBe("pending");
    expect(result.slide_id).toBe(SLIDE_ID);
    expect(result.deck_id).toBe(DECK_ID);

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_delete");
    expect(row.slide_id).toBe(SLIDE_ID);
    expect(row.new_content).toBeNull();
    expect(row.new_slide_payload).toBeNull();
    expect(row.status).toBe("pending");
    expect(row.proposed_by_kind).toBe("claude");
    expect(row.workspace_id).toBe(ctx.workspace_id);
  });
});

describe("propose_duplicate_slide", () => {
  const DECK_ID = "deck-du00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-du00-0000-0000-0000-000000000011";
  const FOREIGN_SLIDE = "slid-du00-0000-0000-0000-0000000000ff";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Dup Deck" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 2,
        title: "Intro",
        html_body: '<section class="slide"><h1>Intro</h1></section>',
        slide_styles: ".slide{color:red}",
        owner_id: null,
        current_version_id: null,
      },
    ];
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("rejects a slide that is not in the caller's workspace", async () => {
    await expect(
      tools.propose_duplicate_slide({ slide_id: FOREIGN_SLIDE }, ctx),
    ).rejects.toThrow(/not found in this workspace/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("inserts a slide_create edit copying the source content at position+1", async () => {
    const result = (await tools.propose_duplicate_slide(
      { slide_id: SLIDE_ID, rationale: "near-copy to tweak" },
      ctx,
    )) as {
      kind: string;
      status: string;
      source_slide_id: string;
      deck_id: string;
      position: number;
    };

    expect(result.kind).toBe("slide_create");
    expect(result.status).toBe("pending");
    expect(result.source_slide_id).toBe(SLIDE_ID);
    expect(result.deck_id).toBe(DECK_ID);
    // Inserted right after the source (source position is 2).
    expect(result.position).toBe(3);

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.kind).toBe("slide_create");
    // slide_create rows carry no slide_id; the payload holds the new content.
    expect(row.slide_id).toBeNull();
    expect(row.new_content).toBeNull();
    expect(row.status).toBe("pending");
    expect(row.proposed_by_kind).toBe("claude");
    expect(row.workspace_id).toBe(ctx.workspace_id);
    // The copy must carry the source's content verbatim at position + 1.
    expect(row.new_slide_payload).toEqual({
      position: 3,
      title: "Intro",
      html_body: '<section class="slide"><h1>Intro</h1></section>',
      slide_styles: ".slide{color:red}",
    });
  });

  it("rejects when the caller is a viewer on a private deck", async () => {
    // Private deck + plain member + a viewer-role canvas_deck_member row. The
    // viewer row lets them READ the deck (passes assertDeckAccessibleToUser) but
    // assertDeckEditableByUser then denies the write — mirrors the other
    // editor-role enforcement tests. No edit row is written.
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "private", title: "Dup Deck" },
    ];
    fakeDb.workspace_memberships = [
      { workspace_id: ctx.workspace_id, user_id: ctx.user_id, role: "member" },
    ];
    fakeDb.canvas_deck_member = [
      { deck_id: DECK_ID, user_id: ctx.user_id, role: "viewer" },
    ];
    await expect(
      tools.propose_duplicate_slide({ slide_id: SLIDE_ID }, ctx),
    ).rejects.toThrow(/read-only/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Patch nudge: a full slide replacement that barely changes the slide should
// come back with a hint steering the next adjustment to propose_slide_patch.
// Prod showed sessions doing full rewrites for one-line tweaks with ZERO patch
// calls — session instructions alone don't steer, the tool result must.
// ---------------------------------------------------------------------------
describe("lineChangeRatio", () => {
  it("is 0 for identical content and 1 for fully disjoint content", () => {
    expect(lineChangeRatio("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(lineChangeRatio("a\nb", "x\ny")).toBe(1);
  });

  it("scales with the share of changed lines", () => {
    const before = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line5", "line5-changed");
    const ratio = lineChangeRatio(before, after);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.15);
  });
});

describe("propose_slide_edit patch nudge", () => {
  const DECK_ID = "deck-nu00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-nu00-0000-0000-0000-000000000002";
  const BASE_VERSION = "vers-nu00-0000-0000-0000-00000000003";
  // 20-line body so a one-line tweak is clearly under the nudge threshold.
  const LINES = Array.from({ length: 18 }, (_, i) => `<p>row ${i}</p>`).join("\n");
  const BODY = `<section class="slide">\n${LINES}\n</section>`;

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Deck" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "T",
        html_body: BODY,
        slide_styles: "",
        owner_id: null,
        current_version_id: BASE_VERSION,
      },
    ];
    fakeDb.canvas_slide_version = [
      { id: BASE_VERSION, slide_id: SLIDE_ID, version_no: 3 },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => resetDb());

  it("hints toward propose_slide_patch when a full rewrite changes almost nothing", async () => {
    const result = (await tools.propose_slide_edit(
      {
        slide_id: SLIDE_ID,
        base_version_no: 3,
        new_html_body: BODY.replace("<p>row 7</p>", "<p>row 7 — tweaked</p>"),
      },
      ctx,
    )) as { hint?: string };
    expect(result.hint).toMatch(/propose_slide_patch/);
    // The proposal itself still goes through — the nudge teaches, not blocks.
    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
  });

  it("does NOT hint on a real redesign (most lines change)", async () => {
    const redesigned = `<section class="slide">\n${Array.from(
      { length: 18 },
      (_, i) => `<div>new block ${i}</div>`,
    ).join("\n")}\n</section>`;
    const result = (await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 3, new_html_body: redesigned },
      ctx,
    )) as { hint?: string };
    expect(result.hint).toBeUndefined();
  });

  it("does NOT hint on title/styles-only edits (no html_body to compare)", async () => {
    const result = (await tools.propose_slide_edit(
      { slide_id: SLIDE_ID, base_version_no: 3, new_title: "Renamed" },
      ctx,
    )) as { hint?: string };
    expect(result.hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// revert_proposal: one-call undo for an APPLIED slide proposal — proposes
// restoring the pre-change version's content as a normal pending slide_edit.
// (Born from prod: 4 failed withdraw_proposal calls on already-applied
// proposals in 2 days = users reaching for an undo that didn't exist.)
// ---------------------------------------------------------------------------
describe("revert_proposal", () => {
  const DECK_ID = "deck-rv00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-rv00-0000-0000-0000-000000000002";
  const PARENT_VERSION = "vers-rv00-0000-0000-0000-00000000003";
  const APPLIED_VERSION = "vers-rv00-0000-0000-0000-00000000004";
  const APPLIED_EDIT = "edit-rv00-0000-0000-0000-000000000005";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Deck" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "After",
        html_body: '<section class="slide"><h1>after</h1></section>',
        slide_styles: "",
        owner_id: null,
        current_version_id: APPLIED_VERSION,
      },
    ];
    fakeDb.canvas_slide_version = [
      {
        id: PARENT_VERSION,
        slide_id: SLIDE_ID,
        version_no: 4,
        parent_version_id: null,
        title: "Before",
        html_body: '<section class="slide"><h1>before</h1></section>',
        slide_styles: ".slide h1{color:teal}",
        source_edit_id: null,
      },
      {
        id: APPLIED_VERSION,
        slide_id: SLIDE_ID,
        version_no: 5,
        parent_version_id: PARENT_VERSION,
        title: "After",
        html_body: '<section class="slide"><h1>after</h1></section>',
        slide_styles: "",
        source_edit_id: APPLIED_EDIT,
      },
    ];
    fakeDb.canvas_deck_edit = [
      {
        id: APPLIED_EDIT,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        slide_id: SLIDE_ID,
        kind: "slide_edit",
        proposed_by: ctx.user_id,
        status: "applied",
        rationale: "Bigger Gantt block",
      },
    ];
  });

  afterEach(() => resetDb());

  it("proposes restoring the pre-change version's full content, pending review", async () => {
    const result = (await tools.revert_proposal({ edit_id: APPLIED_EDIT }, ctx)) as {
      edit_id: string;
      reverts_edit_id: string;
      slide_id: string;
      restores_version_no: number;
      status: string;
    };
    expect(result.reverts_edit_id).toBe(APPLIED_EDIT);
    expect(result.slide_id).toBe(SLIDE_ID);
    expect(result.restores_version_no).toBe(4);
    expect(result.status).toBe("pending");

    // The revert is a normal pending slide_edit carrying the parent version's
    // content — slide untouched until a human approves.
    const rows = fakeDb.canvas_deck_edit.filter((r) => r.id !== APPLIED_EDIT);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("slide_edit");
    expect(row.status).toBe("pending");
    expect(row.new_slide_payload).toEqual({
      title: "Before",
      html_body: '<section class="slide"><h1>before</h1></section>',
      slide_styles: ".slide h1{color:teal}",
    });
    expect(row.base_version_id).toBe(APPLIED_VERSION);
    expect(String(row.rationale)).toMatch(/Revert of applied proposal/);
    // The slide itself is unchanged.
    expect(fakeDb.canvas_deck_slide[0].html_body).toContain("after");
  });

  it("refuses to revert a still-pending proposal (that's withdraw's job)", async () => {
    fakeDb.canvas_deck_edit[0].status = "pending";
    await expect(
      tools.revert_proposal({ edit_id: APPLIED_EDIT }, ctx),
    ).rejects.toThrow(/withdraw_proposal/);
  });

  it("explains when the applied proposal produced no version (structural kinds)", async () => {
    fakeDb.canvas_slide_version[1].source_edit_id = null;
    await expect(
      tools.revert_proposal({ edit_id: APPLIED_EDIT }, ctx),
    ).rejects.toThrow(/did not produce a slide version/);
  });

  it("explains when the proposal created the slide's first version", async () => {
    fakeDb.canvas_slide_version[1].parent_version_id = null;
    await expect(
      tools.revert_proposal({ edit_id: APPLIED_EDIT }, ctx),
    ).rejects.toThrow(/FIRST version/);
  });

  it("refuses to revert when the slide moved on after the applied proposal (would clobber newer edits)", async () => {
    // A later direct edit created version 6; the slide is past the proposal's
    // version 5 now, so the one-click revert must not silently erase v6.
    fakeDb.canvas_slide_version.push({
      id: "vers-rv00-0000-0000-0000-00000000006",
      slide_id: SLIDE_ID,
      version_no: 6,
      parent_version_id: APPLIED_VERSION,
      title: "Even newer",
      html_body: '<section class="slide"><h1>newer</h1></section>',
      slide_styles: "",
      source_edit_id: null,
    });
    fakeDb.canvas_deck_slide[0].current_version_id =
      "vers-rv00-0000-0000-0000-00000000006";
    await expect(
      tools.revert_proposal({ edit_id: APPLIED_EDIT }, ctx),
    ).rejects.toThrow(/changed since proposal/);
    // No revert proposal row written.
    expect(
      fakeDb.canvas_deck_edit.filter((r) => r.id !== APPLIED_EDIT),
    ).toHaveLength(0);
  });

  // Idempotent withdraw (born from prod: 22 of 25 withdraw_proposal errors in
  // 2026-06 targeted an already-APPLIED proposal — the reviewer self-approved
  // before Claude tried to retract). withdraw no longer throws for state; it
  // reports the current status and routes the applied case to revert.
  it("withdraw_proposal on an applied proposal returns a no-op that routes to revert_proposal (not an error)", async () => {
    const result = (await tools.withdraw_proposal({ edit_id: APPLIED_EDIT }, ctx)) as {
      edit_id: string;
      status: string;
      withdrawn: boolean;
      action_required?: string;
      note?: string;
    };
    expect(result.withdrawn).toBe(false);
    expect(result.status).toBe("applied");
    expect(result.action_required).toBe("revert_proposal");
    expect(String(result.note)).toMatch(/revert_proposal/);
    // The applied proposal is untouched — withdraw didn't mutate it.
    expect(
      fakeDb.canvas_deck_edit.find((r) => r.id === APPLIED_EDIT)?.status,
    ).toBe("applied");
  });

  it("withdraw_proposal on an already-resolved proposal is an idempotent no-op", async () => {
    fakeDb.canvas_deck_edit[0].status = "rejected";
    const result = (await tools.withdraw_proposal({ edit_id: APPLIED_EDIT }, ctx)) as {
      withdrawn: boolean;
      already_resolved?: boolean;
      status: string;
    };
    expect(result.withdrawn).toBe(false);
    expect(result.already_resolved).toBe(true);
    expect(result.status).toBe("rejected");
  });

  it("withdraw_proposal on a pending proposal cancels it (flips to rejected)", async () => {
    fakeDb.canvas_deck_edit[0].status = "pending";
    const result = (await tools.withdraw_proposal({ edit_id: APPLIED_EDIT }, ctx)) as {
      status: string;
      withdrawn: boolean;
    };
    expect(result.withdrawn).toBe(true);
    expect(result.status).toBe("rejected");
    const row = fakeDb.canvas_deck_edit.find((r) => r.id === APPLIED_EDIT);
    expect(row?.status).toBe("rejected");
    expect(row?.resolved_by).toBe(ctx.user_id);
  });

  // The idempotent-withdraw rewrite must NOT have weakened the genuine guards:
  // a non-proposer still can't cancel a pending proposal, and an unknown id
  // still errors (only state conditions became no-ops).
  it("withdraw_proposal refuses a non-proposer and leaves the proposal pending", async () => {
    fakeDb.canvas_deck_edit[0].status = "pending";
    fakeDb.canvas_deck_edit[0].proposed_by = "00000000-0000-0000-0000-0000000000ff";
    await expect(
      tools.withdraw_proposal({ edit_id: APPLIED_EDIT }, ctx),
    ).rejects.toThrow(/only the proposer/);
    expect(
      fakeDb.canvas_deck_edit.find((r) => r.id === APPLIED_EDIT)?.status,
    ).toBe("pending");
  });

  it("withdraw_proposal throws for an unknown edit_id", async () => {
    await expect(
      tools.withdraw_proposal({ edit_id: "edit-rv00-0000-0000-0000-0000000000aa" }, ctx),
    ).rejects.toThrow(/not found/);
  });
});

// The MCP propose path stamps a proposal with the user's live chatbox turn
// (0043) so the in-app assistant can surface it inline. It must link ONLY the
// caller's own streaming reply on the same deck; every other case (terminal
// Claude with no live turn, a finished turn, someone else's turn) stays
// unlinked and behaves exactly as before.
describe("assistant turn linkage (0043)", () => {
  const DECK_ID = "deck-al00-0000-0000-0000-000000000001";
  const SLIDE_ID = "slid-al00-0000-0000-0000-000000000002";
  const BASE_VERSION = "vers-al00-0000-0000-0000-00000000003";
  const REPLY_ID = "amsg-al00-0000-0000-0000-000000000004";
  const PATCH = { find: "R$ 1.2M", replace: "R$ 1.4M" };

  function seedDeck() {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Pitch" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: SLIDE_ID,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "T",
        html_body: '<section class="slide"><p>R$ 1.2M</p></section>',
        slide_styles: "",
        owner_id: null,
        current_version_id: BASE_VERSION,
      },
    ];
    fakeDb.canvas_deck_edit = [];
  }

  afterEach(() => resetDb());

  it("stamps the proposal with the caller's streaming turn on this deck", async () => {
    seedDeck();
    fakeDb.canvas_assistant_message = [
      {
        id: REPLY_ID,
        deck_id: DECK_ID,
        user_id: ctx.user_id,
        role: "assistant",
        status: "streaming",
        created_at: new Date().toISOString(),
      },
    ];

    await tools.propose_slide_patch({ slide_id: SLIDE_ID, edits: [PATCH] }, ctx);

    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    expect(fakeDb.canvas_deck_edit[0].assistant_message_id).toBe(REPLY_ID);
  });

  it("leaves the proposal unlinked when no turn is streaming (terminal Claude / finished turn)", async () => {
    seedDeck();
    fakeDb.canvas_assistant_message = [
      {
        id: REPLY_ID,
        deck_id: DECK_ID,
        user_id: ctx.user_id,
        role: "assistant",
        status: "complete", // not streaming → not linkable
        created_at: new Date().toISOString(),
      },
    ];

    await tools.propose_slide_patch({ slide_id: SLIDE_ID, edits: [PATCH] }, ctx);

    expect(fakeDb.canvas_deck_edit[0].assistant_message_id ?? null).toBeNull();
  });

  it("does not link another user's streaming turn", async () => {
    seedDeck();
    fakeDb.canvas_assistant_message = [
      {
        id: REPLY_ID,
        deck_id: DECK_ID,
        user_id: "00000000-0000-0000-0000-0000000000ff",
        role: "assistant",
        status: "streaming",
        created_at: new Date().toISOString(),
      },
    ];

    await tools.propose_slide_patch({ slide_id: SLIDE_ID, edits: [PATCH] }, ctx);

    expect(fakeDb.canvas_deck_edit[0].assistant_message_id ?? null).toBeNull();
  });
});

// propose_deck_patch fans a multi-slide find/replace into ONE pending
// slide_edit row per affected slide (so the inbox batch-approve treats them as a
// unit) and is ATOMIC: any slide's failure aborts the whole batch with no rows
// written. These pin the row shaping + the atomic semantics, reusing the patch
// engine (slide-patch.test.ts) and the per-slide wiring (propose_slide_patch
// above) rather than re-testing them.
describe("propose_deck_patch (multi-slide batch)", () => {
  const DECK_ID = "deck-dp00-0000-0000-0000-000000000001";
  const S1 = "slid-dp00-0000-0000-0000-000000000011";
  const S2 = "slid-dp00-0000-0000-0000-000000000012";
  const V1 = "vers-dp00-0000-0000-0000-000000000021";
  const V2 = "vers-dp00-0000-0000-0000-000000000022";

  beforeEach(() => {
    resetDb();
    fakeDb.canvas_deck = [
      { id: DECK_ID, workspace_id: ctx.workspace_id, visibility: "workspace", title: "Pitch" },
    ];
    fakeDb.canvas_deck_slide = [
      {
        id: S1,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 0,
        title: "Cover",
        html_body: '<section class="slide"><h1>Acme</h1></section>',
        slide_styles: ".slide h1 { color: red; }",
        owner_id: null,
        current_version_id: V1,
      },
      {
        id: S2,
        workspace_id: ctx.workspace_id,
        deck_id: DECK_ID,
        position: 1,
        title: "About",
        html_body: '<section class="slide"><p>About Acme today</p></section>',
        slide_styles: "",
        owner_id: null,
        current_version_id: V2,
      },
    ];
    fakeDb.canvas_deck_edit = [];
  });

  afterEach(() => {
    resetDb();
  });

  it("emits one independent pending slide_edit row per affected slide", async () => {
    const result = (await tools.propose_deck_patch(
      {
        deck_id: DECK_ID,
        edits: [
          { slide_id: S1, find: "Acme", replace: "Globex" },
          { slide_id: S2, find: "Acme", replace: "Globex" },
        ],
        rationale: "Rename Acme -> Globex across the deck.",
      },
      ctx,
    )) as {
      deck_id: string;
      kind: string;
      slides_affected: number;
      edits: Array<{ edit_id: string; slide_id: string; status: string; base_version_id: string | null }>;
    };

    expect(result.kind).toBe("slide_edit");
    expect(result.slides_affected).toBe(2);
    expect(result.edits.map((e) => e.slide_id).sort()).toEqual([S1, S2].sort());

    // Two independent rows — one per slide — each a normal pending slide_edit
    // carrying that slide's base version (so the inbox batch-approve staleness
    // check works) and the resolved full content.
    expect(fakeDb.canvas_deck_edit).toHaveLength(2);
    const row1 = fakeDb.canvas_deck_edit.find((r) => r.slide_id === S1)!;
    const row2 = fakeDb.canvas_deck_edit.find((r) => r.slide_id === S2)!;
    expect(row1.kind).toBe("slide_edit");
    expect(row1.base_version_id).toBe(V1);
    expect(row1.new_slide_payload).toEqual({
      html_body: '<section class="slide"><h1>Globex</h1></section>',
    });
    expect(row2.base_version_id).toBe(V2);
    expect(row2.new_slide_payload).toEqual({
      html_body: '<section class="slide"><p>About Globex today</p></section>',
    });
  });

  it("groups multiple edits on the SAME slide into one proposal", async () => {
    const result = (await tools.propose_deck_patch(
      {
        deck_id: DECK_ID,
        edits: [
          { slide_id: S1, find: "Acme", replace: "Globex" },
          { slide_id: S1, find: "color: red", replace: "color: blue", in: "slide_styles" },
        ],
      },
      ctx,
    )) as { slides_affected: number; edits: Array<{ slide_id: string; edits_applied: number }> };

    // One slide → one proposal, even with two find/replace pairs. This is what
    // keeps the batch-approve "exactly one pending per slide" rule satisfied.
    expect(result.slides_affected).toBe(1);
    expect(fakeDb.canvas_deck_edit).toHaveLength(1);
    expect(result.edits[0].edits_applied).toBe(2);
    const row = fakeDb.canvas_deck_edit[0];
    expect(row.new_slide_payload).toEqual({
      html_body: '<section class="slide"><h1>Globex</h1></section>',
      slide_styles: ".slide h1 { color: blue; }",
    });
  });

  it("is ATOMIC: a non-matching snippet on one slide writes NO rows and names that slide", async () => {
    await expect(
      tools.propose_deck_patch(
        {
          deck_id: DECK_ID,
          edits: [
            { slide_id: S1, find: "Acme", replace: "Globex" }, // would succeed
            { slide_id: S2, find: "not in the slide", replace: "x" }, // fails
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(new RegExp(`slide ${S2}[\\s\\S]*not found`));
    // The successful slide's row must NOT have landed — all-or-nothing.
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects an edit targeting a slide on another deck, writing no rows", async () => {
    const OTHER_DECK = "deck-dp00-0000-0000-0000-0000000000ff";
    fakeDb.canvas_deck.push({
      id: OTHER_DECK,
      workspace_id: ctx.workspace_id,
      visibility: "workspace",
      title: "Other",
    });
    const FOREIGN = "slid-dp00-0000-0000-0000-0000000000fe";
    fakeDb.canvas_deck_slide.push({
      id: FOREIGN,
      workspace_id: ctx.workspace_id,
      deck_id: OTHER_DECK,
      position: 0,
      title: "x",
      html_body: '<section class="slide"><h1>Acme</h1></section>',
      slide_styles: "",
      owner_id: null,
      current_version_id: null,
    });
    await expect(
      tools.propose_deck_patch(
        {
          deck_id: DECK_ID,
          edits: [{ slide_id: FOREIGN, find: "Acme", replace: "Globex" }],
        },
        ctx,
      ),
    ).rejects.toThrow(/does not belong to deck/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });

  it("rejects a malformed edits entry with the offending index, writing no rows", async () => {
    await expect(
      tools.propose_deck_patch(
        { deck_id: DECK_ID, edits: [{ slide_id: S1, find: "Acme", replace: "Globex" }, { find: "x", replace: "y" }] },
        ctx,
      ),
    ).rejects.toThrow(/edits\[1\]\.slide_id/);
    expect(fakeDb.canvas_deck_edit).toHaveLength(0);
  });
});
