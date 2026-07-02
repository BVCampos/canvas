/**
 * Standardised guard for mutating Supabase calls.
 *
 * Background: when RLS rejects an UPDATE or DELETE, Supabase doesn't throw —
 * it returns `{ data: [], error: null }`. Without a `.select()` chain the
 * caller has no way to distinguish "permission denied" from "row not found"
 * from "did mutate". This helper makes the no-op case explicit so server
 * actions return `{ error: ... }` instead of a misleading `{ ok: true }`.
 */
export function ensureAffected(
  data: unknown[] | null | undefined,
  error: { message: string } | null,
  notFoundMessage = "Not allowed, or the row no longer exists.",
): { ok: true } | { error: string } {
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: notFoundMessage };
  return { ok: true };
}
