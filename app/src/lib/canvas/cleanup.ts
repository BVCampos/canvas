// Deck cleanup — orphaned Storage object GC.
//
// Service-role helper that fully removes a deck and its Storage objects.
// **This bypasses RLS** — only call from contexts where you've already
// authorised the operation, never from a user-facing server action.
//
// Production path:
//   - The `deleteDeck` server action does its own RLS-gated DELETE on
//     `canvas_deck` (enforces the "creators and admins" policy) and only uses
//     admin for the Storage object removal step.
//
// Acceptable callers of this helper:
//   - The E2E test (tests/scripts run as the service role and need to clean
//     after themselves so orphans don't accumulate in the seed workspace).
//   - The orphan sweeper (`scripts/sweep-orphans.mts`).
//
// Order of operations:
//   1. List the asset storage paths (admin)
//   2. DELETE the deck row (admin → cascades slides/versions/assets/locks/snapshots)
//   3. Remove Storage objects (admin)
// Step 3 is best-effort; if it fails, the orphans are still listed and can be
// reaped by sweep-orphans.mts.

import { createAdminClient } from "@/lib/supabase/admin";

export type DeleteDeckOutcome = {
  ok: boolean;
  deck_id: string;
  storage_objects_removed: number;
  error?: string;
};

export async function deleteDeckAndAssets(
  deck_id: string,
  workspace_id?: string,
): Promise<DeleteDeckOutcome> {
  const admin = createAdminClient();

  // Collect storage paths first. If workspace_id is supplied we double-check —
  // an extra safety net for the server-action caller.
  let query = admin.from("canvas_deck_asset").select("storage_path").eq("deck_id", deck_id);
  if (workspace_id) query = query.eq("workspace_id", workspace_id);
  const { data: assets, error: listErr } = await query;
  if (listErr) {
    return { ok: false, deck_id, storage_objects_removed: 0, error: listErr.message };
  }

  // Delete the deck row → cascades all child rows (slides, versions, locks,
  // assets, snapshots, comments, sources, edits).
  let deleteQuery = admin.from("canvas_deck").delete().eq("id", deck_id);
  if (workspace_id) deleteQuery = deleteQuery.eq("workspace_id", workspace_id);
  const { error: delErr } = await deleteQuery;
  if (delErr) {
    return { ok: false, deck_id, storage_objects_removed: 0, error: delErr.message };
  }

  // Best-effort Storage cleanup. Failure here doesn't reverse the DB delete —
  // the orphaned bytes can be reaped by a later janitor pass.
  const paths = (assets ?? [])
    .map((a) => a.storage_path as string | null)
    .filter((p): p is string => Boolean(p));

  let removed = 0;
  if (paths.length > 0) {
    const { data: removedRows, error: rmErr } = await admin.storage.from("decks").remove(paths);
    if (rmErr) {
      console.warn(`[deleteDeck] storage cleanup partial — ${rmErr.message}`);
    } else {
      removed = removedRows?.length ?? 0;
    }
  }

  return { ok: true, deck_id, storage_objects_removed: removed };
}
