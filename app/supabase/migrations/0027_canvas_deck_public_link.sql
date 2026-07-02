-- ============================================================
-- Public "anyone with the link can view" sharing — migration 0027
-- ============================================================
-- Adds an opt-in, unauthenticated read-only share link for a deck — the
-- Google-Slides "Anyone with the link can view" affordance.
--
-- Design (mirrors the existing signed-asset cookieless pattern, NOT anon RLS):
--   * canvas_deck.public_share_token — a high-entropy random string. NULL means
--     the deck is NOT publicly shared (the default for every existing deck).
--     A non-null value is an unguessable capability: knowing it is the entire
--     authorization to read that one deck.
--   * The public viewer (`/p/{token}`) and its render route
--     (`/api/public/deck/{token}/preview`) resolve the deck via the
--     service-role client gated SOLELY by an exact token match. We deliberately
--     grant the `anon` Postgres role NOTHING here — there are no anon RLS
--     policies to reason about, so the blast radius of a policy mistake stays
--     zero. This matches how /api/canvas/asset already serves bytes to the
--     sandboxed (cookieless) preview iframe via an HMAC signature.
--   * Writing the token (enable / disable / rotate) goes through the caller's
--     RLS-aware client, so the existing "editors and admins update decks"
--     UPDATE policy on canvas_deck is the authoritative gate — only someone who
--     can edit the deck can mint or revoke its public link. No new policy
--     needed; RLS is row-level, so an editor may write this new column.
--
-- Revocation semantics: setting the column back to NULL (disable) or to a fresh
-- value (rotate) makes every previously-shared URL 404 on the next request,
-- because the render route's lookup is an exact equality match.
-- ============================================================

alter table public.canvas_deck
  add column if not exists public_share_token text;

-- Unguessable, view-only capability token. Partial unique index: only indexes
-- shared decks, and guarantees two decks can never collide on a token (the
-- server generates 192 bits of randomness, so a collision is astronomically
-- unlikely — this is a correctness backstop, and the enable/rotate action
-- retries on the 23505 it would raise).
create unique index if not exists canvas_deck_public_share_token_key
  on public.canvas_deck(public_share_token)
  where public_share_token is not null;

comment on column public.canvas_deck.public_share_token is
  'Opt-in public view-only share link capability. NULL = not shared. A non-null '
  'value is an unguessable token; the /p/{token} viewer resolves the deck via the '
  'service-role client gated only by an exact match on this column. Minted/revoked '
  'by deck editors (gated by the canvas_deck UPDATE RLS policy); never exposed to '
  'the anon Postgres role via RLS.';
