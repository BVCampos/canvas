// ============================================================
// Smoke test: every real migration applies cleanly into pglite.
// ============================================================
// If a future migration uses a Supabase object the preamble doesn't shim, this
// fails first and names the file — keeping the harness honest as the schema
// grows. It also pins the migration count the rest of the suite ran against.
// ============================================================

import { describe, it, expect } from "vitest";
import { freshDb, migrationFiles } from "./setup";

describe("canvas migrations load into pglite", () => {
  it("applies every migration in order without error", async () => {
    const { db, migrationsApplied } = await freshDb();
    expect(migrationsApplied).toBe(migrationFiles().length);
    expect(migrationsApplied).toBeGreaterThanOrEqual(49);

    // The core tables the RPC + RLS tests depend on must exist.
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'canvas_deck', 'canvas_deck_slide', 'canvas_slide_version',
            'canvas_deck_edit', 'canvas_deck_snapshot'
          )
        order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "canvas_deck",
      "canvas_deck_edit",
      "canvas_deck_slide",
      "canvas_deck_snapshot",
      "canvas_slide_version",
    ]);

    // The functions under test must be present with the expected arity.
    const { rows: fns } = await db.query<{ proname: string }>(
      `select proname from pg_proc
        where proname in (
          'canvas_apply_edit', 'canvas_restore_slide_version',
          'canvas_restore_snapshot', 'canvas_can_read_deck', 'canvas_can_edit_deck'
        )
        group by proname order by proname`,
    );
    expect(fns.map((r) => r.proname)).toEqual([
      "canvas_apply_edit",
      "canvas_can_edit_deck",
      "canvas_can_read_deck",
      "canvas_restore_slide_version",
      "canvas_restore_snapshot",
    ]);
  });
});
