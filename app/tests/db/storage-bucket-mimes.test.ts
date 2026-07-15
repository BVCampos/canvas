// ============================================================
// Drift guard: the `decks` bucket accepts every mime the parser emits.
// ============================================================
// The parser (ASSET_MIME_ALLOWLIST → ASSET_UPLOAD_MIMES) decides which
// data-URI assets get lifted out of an imported deck; the importer then
// uploads each one to the `decks` storage bucket, whose allowed_mime_types
// lives in migrations (0003, widened by 0077). When the two lists drift, the
// importer throws mid-import and the WHOLE deck fails — that's exactly how
// prod imports broke on `font/ttf` (2026-07-11). This pins bucket ⊇ parser
// after all migrations run, so adding a mime to one list without the other
// fails CI instead of prod.
// ============================================================

import { describe, it, expect } from "vitest";
import { freshDb } from "./setup";
import { ASSET_UPLOAD_MIMES } from "../../src/lib/canvas/parser";

describe("decks storage bucket mime allow-list", () => {
  it("accepts every mime the parser can emit for upload", async () => {
    const { db } = await freshDb();
    const { rows } = await db.query<{ allowed_mime_types: string[] | null }>(
      `select allowed_mime_types from storage.buckets where id = 'decks'`,
    );
    expect(rows).toHaveLength(1);
    const bucket = rows[0].allowed_mime_types;
    expect(bucket).not.toBeNull();

    const missing = ASSET_UPLOAD_MIMES.filter((m) => !bucket!.includes(m));
    expect(missing).toEqual([]);
  });
});
