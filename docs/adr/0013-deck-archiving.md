# ADR-0013 — Deck archiving

**Status:** accepted  
**Date:** 2026-07-04  
**Extends:** ADR-0002 (deck decomposition)

## Context

The only way to get a deck out of the `/canvases` list was to **delete** it —
which erases every slide, version, snapshot, and storage asset and cannot be
undone (`deleteDeck`). A finished or abandoned deck that someone might still
want to reference had no home: keep it and clutter the list, or delete it and
lose it. Teams asked for the ordinary "put it on a shelf" affordance every
tool has (Gmail, Notion, Linear): reversible, non-destructive, out of the way.

## Decision

Add `canvas_deck.archived_at timestamptz` (nullable; migration 0074). `null` =
active, a timestamp = archived **and when**. Archiving hides a deck from the
default listings; unarchiving is one write back to `null`.

### A. A nullable timestamp, not a status enum value

Archiving is **orthogonal** to the two axes a deck already has, so it gets its
own column rather than overloading either:

- `status` (`draft` / `in_review` / `final`) is **editorial state**. A "final"
  deck can be archived and stay final — folding `archived` into the status enum
  would destroy that pairing and break the status filter's meaning.
- `visibility` (`workspace` / `private`) is an **access boundary**. Archiving
  changes neither who can read/edit the deck nor any live public link.

The timestamp-as-flag idiom matches the rest of the schema (`accepted_at`,
`resolved_at`, `deleted_at`-style markers) and records the archive time for free,
which the archived view uses to order the shelf and to show "Archived {ago}".

### B. Archiving is access-preserving — a shelf, not a lock

An archived deck **still opens, edits, exports, and — if it already has a
`public_share_token` — still serves at `/p/{token}`**. Archiving removes it from
the deck browse/pick surfaces (enumerated under Consequences); `/canvases` and
`list_decks` also offer an explicit "include archived" view. Unpublishing
(revoking a public link) is a **separate** intent with its own control,
deliberately not coupled to archiving. Consequently there are **no RLS changes** —
reads and edits are unaffected. The *write*, however, is authorized
**creator-or-admin in code** (via the existing `is_workspace_admin_or_owner`
RPC), not by RLS alone: the shared "editors and admins update decks" policy
(migration 0015 → 0017) also admits deck-editor members, and archiving — which
pulls a deck from *everyone's* list — is scoped like Delete, tighter than an
ordinary edit. This mirrors `setDeckAgentFastLane`, the existing in-file
precedent for a creator/admin guard on a `canvas_deck` column write. (`status`
and `visibility` stay editor-level by design; archive is deliberately tighter.)

### C. No agent-facing write path

Archiving is a human organizational act about *your* list, so it never arrives
as a proposal and there is **no `archive_deck` MCP tool**. Agents only *observe*
it: `list_decks` hides archived decks unless `include_archived: true` and returns
`archived_at` on every row; `get_deck` returns `archived_at`; `list_projects`
deck-counts exclude archived decks (parity with the page's active-only counts).

### D. Surfaces

- **`/canvases`** gains an **Active / Archived** view toggle (a URL flag,
  `?archived=1`) that appears only once something is archived. Active view keeps
  the project grouping; the archived view is a flat shelf, most-recently-archived
  first. The per-row `⋯` menu gains **Archive** ↔ **Unarchive** (`canManageDeck`
  = creator/admin gate, same as Delete), no confirm — it's reversible.
- **The editor** shows an **Archived** chip by the title and an Archive /
  Unarchive item in the deck overflow menu (creator/admin-gated to match the row
  menu and the in-code guard); the deck stays fully editable.

## Consequences

- Deleting stays the destructive escape hatch; archiving is the reversible,
  everyday one. The Delete affordance is unchanged and still available on the
  archived shelf.
- **Surface coverage is deliberate, not blanket.** Archived decks drop out of
  the deck **browse/pick** surfaces — the `/canvases` list, MCP `list_decks`,
  `list_projects` deck-counts, and the cross-deck **copy-from-deck** picker
  (`listCopySources`; it's recency-ordered and archiving bumps `updated_at`, so
  leaving them in would float freshly-archived decks to the top — the opposite of
  decluttering). Two surfaces intentionally **keep** archived decks: the
  `/settings/sharing` public-link overview (so an archived deck with a live
  public link can't silently keep exposing itself off-radar) and the proposal
  **inbox** (a pending proposal stays actionable regardless of the deck's shelf
  state). Per-deck pages, export, thumbnails, and the public viewers are
  unaffected by design — access is preserved; only browse listings change.
- Because the `set_updated_at_canvas_deck` trigger fires on any UPDATE,
  archiving/unarchiving bumps `updated_at`; the archived view orders by
  `archived_at` (not `updated_at`) so the shelf stays chronological by when
  things were put away, and an unarchived deck resurfaces near the top of the
  active list (recently touched — acceptable).
- Additive, nullable column + partial index (`… where archived_at is null`) over
  the hot "active decks in a workspace" scan. No backfill: existing decks are
  `null` = active, so behavior is unchanged until someone archives. The migration
  must ship in the same merge as the code (the list/tool selects reference the
  column). See the deck-archive plan and CONTEXT.md → **Archived deck**.
