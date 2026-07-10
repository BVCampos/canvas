-- ============================================================
-- Canvas deck archiving — migration 0074
-- ============================================================
-- Adds canvas_deck.archived_at: a nullable timestamp that doubles as the
-- archived flag (null = active, non-null = archived, and records WHEN).
--
-- Archiving is a shelf, not a lock. It is deliberately NOT a new status enum
-- value and NOT a visibility change:
--   * `status` (draft/in_review/final) is editorial state — orthogonal; a
--     "final" deck can be archived and stay final.
--   * `visibility` (workspace/private) is an access boundary — archiving
--     changes NEITHER who can read/edit the deck NOR any live public link.
-- What archiving does is drop the deck from the browse/pick surfaces — the
-- DEFAULT /canvases list, MCP list_decks, list_projects deck-counts, and the
-- copy-from-deck picker — while /settings/sharing and the proposal inbox keep
-- it; only /canvases and list_decks offer an "include archived" opt-in. An
-- archived deck still opens, edits, exports, and — if it already has a
-- public_share_token — still serves at /p/{token}. Unarchiving is one write
-- back to null.
--
-- No RLS changes: writing archived_at is an UPDATE on canvas_deck, already
-- gated by the "editors and admins update decks" policy (migration 0015 →
-- 0017). No new RPC and no agent-facing write tool — archiving is a human
-- organizational act, so it never arrives as a proposal.
--
-- Idempotent: add-column-if-not-exists + create-index-if-not-exists.
-- ============================================================

alter table public.canvas_deck
  add column if not exists archived_at timestamptz;

-- The hot query is "active decks in a workspace, newest first" (the /canvases
-- index and MCP list_decks default). A partial index over the active rows
-- keeps that scan off the archived tail; it follows the same (workspace_id, …)
-- leading-column convention as canvas_deck_visibility_idx from 0015 (that one
-- is a plain, non-partial (workspace_id, visibility) index — this is partial on
-- archived_at with updated_at desc for the order-by).
create index if not exists canvas_deck_workspace_active_idx
  on public.canvas_deck(workspace_id, updated_at desc)
  where archived_at is null;

comment on column public.canvas_deck.archived_at is
  'When the deck was archived (shelved from default listings). NULL = active. '
  'Orthogonal to status and visibility; archiving does not change access or '
  'revoke public links. See ADR-0013.';
