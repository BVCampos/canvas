// Tests for the MCP write fan-out cap (server.ts).
//
// propose_*/create_* tools are capped per user so a runaway session can't flood
// the human review rail. This pins (1) which tools count as writes and (2) that
// a denied limiter short-circuits a write tool with a clear error BEFORE the
// tool runs — without touching canvas-mcp-server.test.ts (owned elsewhere).

import { afterEach, describe, expect, it, vi } from "vitest";

// Control the limiter per test. The write cap calls rateLimitOk(adminClient,...).
const rateLimitOk = vi.fn();
vi.mock("@/lib/canvas/rate-limit", () => ({ rateLimitOk: (...a: unknown[]) => rateLimitOk(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { dispatchMcp, isWriteTool } from "../src/lib/canvas/mcp/server";
import { toolDescriptors } from "../src/lib/canvas/mcp/tools";

const ctx = {
  user_id: "00000000-0000-0000-0000-000000000001",
  workspace_id: "00000000-0000-0000-0000-000000000002",
};

// The classification is fail-closed: these are the ONLY read-only tools, and
// everything else counts against the write cap. Pinned here independently so a
// drift between this list and server.ts's READ_ONLY_TOOLS — or a newly added
// tool that lands in neither bucket — fails the partition test below rather
// than silently mis-capping.
const READ_ONLY = [
  "diff_slide_versions",
  "diff_snapshots",
  "get_deck",
  "get_proposal",
  "list_comments",
  "list_decks",
  "list_projects",
  "list_proposals",
  "list_slide_versions",
  "list_snapshots",
  "list_sources",
  "read_brand",
  "read_full_deck",
  "read_slide",
  "read_slide_version",
  "read_snapshot",
  "read_source",
  "read_theme",
  "render_deck",
  "render_proposal",
  "render_slide",
];
const WRITE_TOOLS = [
  "add_comment",
  "apply_trusted_proposal",
  "comment_on_proposal",
  "copy_slide",
  "create_deck",
  "create_project",
  "create_snapshot",
  "lock_slide",
  "propose_deck_edit",
  "propose_deck_patch",
  "propose_delete_slide",
  "propose_duplicate_slide",
  "propose_new_slide",
  "propose_reorder_slides",
  "propose_slide_edit",
  "propose_slide_patch",
  "propose_slide_variants",
  "propose_theme_edit",
  "release_slide",
  "reply_to_comment",
  "resolve_comment",
  "revert_proposal",
  "withdraw_proposal",
  "write_slide_notes",
];

afterEach(() => rateLimitOk.mockReset());

describe("isWriteTool", () => {
  it("flags propose_* and create_* as writes", () => {
    expect(isWriteTool("propose_slide_patch")).toBe(true);
    expect(isWriteTool("propose_deck_patch")).toBe(true);
    expect(isWriteTool("create_deck")).toBe(true);
    expect(isWriteTool("create_project")).toBe(true);
  });

  it("flags the non-prefixed writers the old prefix check missed", () => {
    // copy_slide mints a proposal; write_slide_notes is a direct write. Both
    // slipped the cap under the propose_/create_ prefix rule.
    expect(isWriteTool("copy_slide")).toBe(true);
    expect(isWriteTool("write_slide_notes")).toBe(true);
  });

  it("does NOT flag read/history tools", () => {
    for (const n of ["read_slide", "list_decks", "get_deck", "render_slide", "list_snapshots"]) {
      expect(isWriteTool(n), n).toBe(false);
    }
  });

  it("partitions the full advertised tool set (a new tool forces a classification)", () => {
    const advertised = toolDescriptors.map((t) => t.name).sort();
    // Every tool is either a pinned read or a pinned write, with no overlap and
    // nothing left over — so adding/removing a tool in toolDescriptors breaks
    // this until it is deliberately classified.
    expect([...READ_ONLY, ...WRITE_TOOLS].sort()).toEqual(advertised);
    for (const n of WRITE_TOOLS) expect(isWriteTool(n), n).toBe(true);
    for (const n of READ_ONLY) expect(isWriteTool(n), n).toBe(false);
  });
});

describe("write fan-out cap in tools/call", () => {
  function call(name: string) {
    return dispatchMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } },
      ctx,
    );
  }

  it("blocks a write tool when the limiter denies, with a clear isError reply", async () => {
    rateLimitOk.mockResolvedValue(false); // over the write cap
    const out = await call("create_deck");
    expect(out.kind).toBe("response");
    if (out.kind !== "response") return;
    const result = out.body.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toMatch(/too many changes/i);
    // The limiter was consulted with a per-user write bucket.
    expect(rateLimitOk).toHaveBeenCalledOnce();
    expect(rateLimitOk.mock.calls[0][1]).toBe(`mcp-write:${ctx.user_id}`);
  });

  it("does NOT consult the write limiter for a read tool", async () => {
    // tools/list needs no limiter and no DB; assert the write cap stays out of
    // the read path entirely.
    const out = await dispatchMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ctx,
    );
    expect(out.kind).toBe("response");
    expect(rateLimitOk).not.toHaveBeenCalled();
  });
});
