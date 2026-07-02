// Snapshot-guard for the MCP tool descriptions — the REAL prompt.
//
// The multi-paragraph `description` strings in mcp/tools.ts are what steer
// Claude's edit loop (patch-first vs full-rewrite, build-from-current-content,
// echo base_version_no). They can be reworded freely with nothing flagging the
// behavioral change in review. The editing-10x discovery showed how costly a
// mis-steer is (21 full rewrites, 0 patch calls). These tests fail loudly when
// a steering phrase is dropped or the tool set changes, forcing the prompt
// change to be a reviewed decision rather than an invisible one.

import { describe, expect, it } from "vitest";
import { toolDescriptors } from "../src/lib/canvas/mcp/tools";

function describedBy(name: string): string {
  const tool = toolDescriptors.find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" not in toolDescriptors`);
  return tool.description;
}

describe("MCP tool descriptions (the prompt)", () => {
  it("every descriptor has a name, a non-trivial description, and an object inputSchema", () => {
    for (const t of toolDescriptors) {
      expect(t.name, "tool name").toMatch(/^[a-z_]+$/);
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(20);
      expect(t.inputSchema?.type, `${t.name} inputSchema`).toBe("object");
    }
  });

  it("pins the exact advertised tool set (adding/removing a tool is a reviewed diff)", () => {
    const names = toolDescriptors.map((t) => t.name).sort();
    expect(names).toMatchInlineSnapshot(`
      [
        "add_comment",
        "apply_trusted_proposal",
        "comment_on_proposal",
        "copy_slide",
        "create_deck",
        "create_project",
        "create_snapshot",
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
        "read_brand",
        "read_full_deck",
        "read_slide",
        "read_slide_version",
        "read_snapshot",
        "read_source",
        "read_theme",
        "release_slide",
        "render_deck",
        "render_proposal",
        "render_slide",
        "reply_to_comment",
        "resolve_comment",
        "revert_proposal",
        "withdraw_proposal",
        "write_slide_notes",
      ]
    `);
  });

  it("propose_slide_patch keeps its fast-path / find-replace / preferred steer", () => {
    const d = describedBy("propose_slide_patch");
    expect(d).toContain("fast path");
    expect(d).toContain("find/replace");
    expect(d).toContain("Strongly preferred over propose_slide_edit");
    // The anti-clobber discipline: each find must match CURRENT content.
    expect(d.toLowerCase()).toContain("current");
  });

  it("propose_slide_edit steers toward patch and demands a fresh base_version_no", () => {
    const d = describedBy("propose_slide_edit");
    expect(d).toContain("prefer propose_slide_patch");
    expect(d).toContain("base_version_no");
    // The stale-clobber warning must survive any reword.
    expect(d).toContain("stale");
  });
});
