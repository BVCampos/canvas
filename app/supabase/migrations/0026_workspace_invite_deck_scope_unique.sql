-- ============================================================
-- Deck-aware pending-invite uniqueness (migration 0026)
-- ============================================================
-- Migration 0000 created `workspace_invites_unique_pending` as
--   unique (workspace_id, lower(email)) where accepted_at is null
-- which predates deck-scoped guest invites (migration 0025 added deck_id /
-- deck_role). With a single scope-blind index there can be only ONE pending
-- invite per email per workspace, regardless of what it targets — so:
--   * a workspace member invite (deck_id null) and a per-deck guest invite for
--     the same email collide, and
--   * the same outside reviewer can't be invited to two different decks at once
--     (deck A guest invite blocks deck B guest invite).
-- The two surfaces are managed by different people (workspace admins via
-- /settings/members vs deck editors via the Share dialog), so the collision is
-- a confusing cross-surface block that surfaces as a misleading "already
-- pending" error pointing at the wrong place.
--
-- Split the uniqueness rule by scope:
--   * at most one pending WORKSPACE invite per (workspace, email)   [deck_id null]
--   * at most one pending GUEST invite per (workspace, email, deck) [deck_id set]
--
-- Behaviour for existing rows is unchanged: the old index already guaranteed at
-- most one pending invite per (workspace, lower(email)), which cannot violate
-- either narrower index, so both CREATE statements succeed on live data.
-- ============================================================

drop index if exists public.workspace_invites_unique_pending;

create unique index if not exists workspace_invites_unique_pending_workspace
  on public.workspace_invites (workspace_id, lower(email))
  where accepted_at is null and deck_id is null;

create unique index if not exists workspace_invites_unique_pending_deck
  on public.workspace_invites (workspace_id, lower(email), deck_id)
  where accepted_at is null and deck_id is not null;
