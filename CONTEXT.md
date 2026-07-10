# 21x Canvas — Domain Glossary

Canonical vocabulary for the Canvas product. When a term appears in code, docs, or UI it must mean what's defined here. If you reach for a synonym, update this file instead.

## What this product is

Canvas is an agent-agnostic multiplayer editor for HTML decks and other HTML artifacts. The collaboration unit is the **slide**; each slide can be owned by a user, edited through Codex, Claude Code, or another MCP-compatible agent, and reviewed through proposals and threaded comments before being applied. The product is a standalone Next.js app with its own Supabase project and auth; see ADR-0004 for the split and ADR-0009 for the client model.

## Core entities

### Workspace
The unit of tenancy. Lives in `public.workspaces` in Canvas's own Supabase project; the schema is identical to the one in `21x-workforce-management` (and was ported verbatim — see migration 0000) but the rows are independent. Every Deck belongs to exactly one Workspace via `workspace_id`, and access is gated by the RLS helpers `public.is_workspace_member`, `public.is_workspace_admin_or_owner`, `public.is_workspace_owner`.

### Project
A named group of Decks inside a Workspace — typically one client proposal holding its decks. Stored in `public.canvas_project` (migration 0038); a Deck points at it via nullable `canvas_deck.project_id` (`ON DELETE SET NULL` — deleting a Project never deletes its decks, they fall back to the ungrouped list). Names are unique per workspace (case-insensitive). Surfaced as section groups on `/canvases`, a picker on `/canvases/new`, and the MCP tools `list_projects` / `create_project` (+ `project_id` on `create_deck` / `list_decks`).

A Project is also a **shareable unit** (migration 0046, mirroring per-deck sharing): it carries its own `visibility` (`workspace` | `private`), an explicit `canvas_project_member` ACL (viewer | editor), guest invites (`workspace_invites.project_id` / `project_role`), and a public "anyone with the link" token (`public_share_token` → `/p/project/{token}`). Sharing is **additive / union, never narrowing**: a project member reaches *every* deck in the project regardless of each deck's own visibility — implemented by one extra branch in `canvas_can_read_deck` / `canvas_can_edit_deck` that unions on `canvas_project_member`. The cascade keys on project **membership** only, **not** a project's workspace-visibility, so merely grouping a private deck under a normal project never exposes it. A Project's own `visibility` gates who sees the project group; guests with a `canvas_project_member` row see the project taxonomy (the SELECT policy moved from `is_workspace_member_full` to `canvas_can_read_project`).

- ✗ Not "folder" — the UI and tools say Project
- ✗ Not the legacy `canvas_deck.proposal_id` soft pointer (a dead reference to workforce-management's CRM, see Deck below) and not an Edit proposal (`canvas_deck_edit`)

### Deck
A single HTML artifact — typically a presentation. Composed of an ordered set of Slides + a shared **theme** (deck-level CSS) + an optional **nav** script. Stored in `public.canvas_deck`. Belongs to at most one Project via `project_id` (nullable, see above). Carries `client_id` and `proposal_id` UUID columns that originally referenced workforce-management's `clients` / `proposals` tables; since the standalone split (ADR-0004) those are plain UUIDs with no FK — they survive as soft pointers but Canvas no longer enforces or surfaces them in the UI. Grouping decks under a proposal is what Project is for.

- ✗ Not "presentation" (we may eventually allow non-slide decks like single-page reports)
- ✗ Not "canvas" — Canvas is the product name; the artifact is a Deck

### Archived deck
A deck shelved out of the default list without being deleted. Stored as
`canvas_deck.archived_at` (nullable timestamp, migration 0074): `null` = active,
a timestamp = archived (and when). Archiving is **orthogonal** to both `status`
(editorial: draft/in_review/final) and `visibility` (access: workspace/private),
and it is **access-preserving** — an archived deck still opens, edits, exports,
and, if it already has a `public_share_token`, still serves at `/p/{token}`. What
it does is drop the deck from the deck **browse/pick** surfaces — the default
`/canvases` list, MCP `list_decks`, `list_projects` deck-counts, and the
copy-from-deck picker (`listCopySources`) — while the `/settings/sharing`
public-link overview and the proposal inbox deliberately keep it. Only `/canvases`
and `list_decks` offer an explicit include-archived view (`/canvases?archived=1`,
`list_decks(include_archived: true)`). Reversible in one write back to `null`.
Archiving is **creator/admin-only** (it pulls a deck from everyone's list — scoped
like Delete): `setDeckArchived` authorizes creator-or-admin **in code** (via
`is_workspace_admin_or_owner`), because the shared "editors and admins update
decks" policy also admits deck-editor members — the same guard pattern as
`setDeckAgentFastLane`. No new RLS/table, and **no agent write tool** (archiving
is a human organizational act, never a proposal). See ADR-0013.

- ✗ Not delete (`deleteDeck` is destructive + irreversible; archive is neither)
- ✗ Not a `status` value and not a `visibility` change

### Slide
The unit of collaboration. One `<section class="slide ...">` from the source HTML maps to one row in `public.canvas_deck_slide`. Each Slide stores: ordered `position`, `title`, `html_body`, `slide_styles` (slide-scoped CSS that doesn't belong in the deck theme), `owner_id`, `status`.

### Speaker Notes
The presenter's talk track for one Slide — `canvas_deck_slide.speaker_notes` (migration 0067), plain text, not part of the rendered HTML (never exported, never in the public viewer). Agents write them via the MCP tool `write_slide_notes` — a direct column write, not a proposal, because notes are presenter aid, not deck content, so they skip the review gate. The RPC `canvas_save_slide_notes_direct` exists for future user-session writers (the MCP path runs service-role and writes the column itself). Present mode shows the current slide's notes to the presenter.

### Drawn slide
A Slide whose body is a freehand drawing (Excalidraw-style): a `<section class="slide canvas-draw-slide">` wrapping an `<svg viewBox="0 0 1280 720">`, with the editable scene (element list) stashed URL-encoded on a `data-canvas-scene` attribute so the draw surface re-opens it losslessly. It's still plain HTML, so it renders in preview, export, and thumbnails with no special-casing. Created with the **Draw a slide** surface (`draw-canvas.tsx` + the pure `lib/canvas/draw/scene.ts`); see ADR-0012. The slide loader flags drawn slides (`is_drawn`) so the editor can offer **Edit drawing**.

### Drawing overlay
A transparent drawing layer on TOP of a normal Slide's existing HTML — the **Draw over slide** / **Edit annotation** surface. Serializes to an absolutely-positioned `<svg class="canvas-draw-overlay" data-canvas-scene="…">` injected as the last child of the slide's `<section>` (`injectDrawOverlay` in `lib/canvas/draw/scene.ts`), so like a Drawn slide it renders in preview/export/thumbnails for free and re-opens losslessly. The distinction that matters: a fresh drawn slide is *additive* and saves direct, but an overlay **edits existing content**, so its save routes through the inline-edit gate — direct for direct editors, a proposal otherwise. An empty scene strips the layer ("erase all" round-trips to a clean slide). The loader flags overlays (`has_overlay`) so the editor offers **Edit annotation**; the editing backdrop is the preview route's single-slide mode (`?slideId=…&stripOverlay=1`). See ADR-0012 §A′.

### Theme
Deck-level CSS shared across all slides. Stored on `canvas_deck.theme_css`. Edited via a separate "Edit theme" surface; admin/owner only by convention (UI-enforced in v1).

### Brand Kit
Workspace-level brand: at most one `public.canvas_brand` row per workspace (unique `workspace_id`, migration 0065) holding a flat `tokens` jsonb bag (colors / fonts — JSON rather than CSS so tools can query individual values) and a freeform `voice` text carrying the house writing rules. Edited at `/settings/brand` (admin/owner); read by agents via the MCP tool `read_brand`, and folded into the in-app assistant's context as a strippable preamble (`withBrandContext`) so generated slides inherit the look and the copy voice. Advisory in v0 — nothing enforces the tokens against a deck's actual CSS.

### Slide Lock
Soft lock on a slide. Acquired when a person or their agent starts editing; expires after 15 minutes if not renewed. `locked_by_kind = 'user' | 'agent'` gives provider-neutral attribution. Warns collaborators before two actors race on the same slide. Stored in `public.canvas_deck_slide_lock`.

### Edit
A proposed change to a slide body, slide styles, deck theme, or nav script. Created with status `pending`; reviewer transitions to `applied` or `rejected`. Old applied edits become history (`status='superseded'` if overwritten). Stored in `public.canvas_deck_edit`. The deck's current state is the result of replaying applied edits, but for query speed we also mutate `canvas_deck_slide.html_body` directly when an Edit is applied — the Edit row remains as the audit trail.

Edits arrive over MCP two ways: `propose_slide_edit` carries full replacement content (redesigns), and `propose_slide_patch` carries find/replace snippets that the server resolves against the slide's current content (targeted adjustments — the fast path; see `app/src/lib/canvas/slide-patch.ts`). Both persist the same whole-content `kind='slide_edit'` row, so review/apply never distinguishes them.

`propose_slide_edit` additionally requires `base_version_no` — the `current_version_no` from the caller's latest read of that slide. The server rejects a mismatch, because a full replacement composed from a stale in-context copy would, once approved, silently revert every newer version (typically a human's direct edits in the web UI). The row's `base_version_id` can't catch this: it's stamped server-side at proposal-insert time, so it always reflects the version that was current when the proposal arrived, not the version the caller actually read. Patches don't need the echo — find/replace resolves against current content and misses loudly when the slide moved on.

### Comment
Threaded discussion attached to a Slide (typical) or to the Deck. Supports `@mentions` (array of user ids in `mentions` jsonb). `author_kind = 'claude'` is the legacy persisted value for any comment posted by an agent through MCP; `author_id` still references the human whose token was used. Reserved `element_selector` supports future DOM-anchored annotations.

### Guest comment (public-link feedback)
A Comment posted from the public viewer `/p/{token}` when the deck opts in (`canvas_deck.public_comments_enabled`, default off). The recipient passes a one-time name gate — name required, email optional — stored on the row as `author_name` / `author_email` (migration 0064): unverified attribution, labeled as such, with `author_id` null. On the row it persists as `author_kind='client'` — the guest-authorship marker, paired with `client_session` as the per-guest partition key — unrelated to the deck's legacy CRM `client_id` soft pointer (above). Guest comments land in the deck's normal comment threads, so the team sees and replies to them in the editor like any other thread, and the replies render back in the guest's sheet. Every public read and write carries an opaque per-browser session key (`canvas_comment.client_session`, migration 0069; localStorage `canvas:guest-session`), and the public list is partitioned by it — one link sent to several recipients never shows one guest another guest's feedback. That partition is privacy-by-default between recipients, not authorization.

### Source
A pinned reference (PDF, URL, raw text, file). Attached to a Deck (global context) or a Slide (slide-specific). Sources are what agents read when drafting; they are not part of the deck output.

### Asset
A binary blob extracted from imported HTML (typically a base64 `<img>` data URL). Stored in the `decks` Supabase Storage bucket and referenced via `storage_path`. The importer rewrites the original `<img src="data:...">` to `<img src="/asset/{id}">` to massively shrink deck size (the seed example dropped from 560KB to ~50KB).

### MCP Token
Per-user bearer secret sent to `/api/mcp` (the legacy personal URL `/api/mcp/{token}` remains compatible). Identifies the user and scopes them to one Workspace. Issued from `/settings/mcp`. Stored in `public.canvas_mcp_token`. The MCP route resolves token → user through the service-role client, then every tool explicitly re-enforces workspace and deck access because the admin client bypasses RLS. The same token authenticates the local **assistant bridge** (below).

### Assistant thread / message / runtime
The in-app **Ask agent** chatbox (ADR-0006, ADR-0007, ADR-0009, ADR-0010). A conversation is a `public.canvas_assistant_thread` scoped to `(deck, user)`; prompts and replies are `public.canvas_assistant_message` rows carrying `thread_id` and `execution_runtime`. The first queued prompt creates and titles a thread. A turn runs either through the user's local `canvas-agent` bridge (`bridge`, Codex/Claude adapters today) or server-side through the user's own OpenRouter API key (`openrouter`). OpenRouter credentials live in the service-only `public.canvas_user_ai_provider_config`, encrypted with AES-256-GCM; the browser receives only a masked hint. `model_id` may be a comma-separated preference list (`primary, fallback, …`): the runner sends the first as the primary and the rest as OpenRouter's `models` fallback array, so a routing flap fails over server-side instead of killing the turn. Rounds that carry render images run on the **vision relay** (`minimax/minimax-m3`) when the chosen model is text-only — OpenRouter rejects image parts sent to a text-only model with a deterministic 404 — and the primary model resumes once the images are consumed; connection validation therefore requires tool calling only, not image input. For a reasoning model, the turn's visible thinking streams into `canvas_assistant_message.reasoning` (migration 0070) alongside `content`, rendered as a collapsible "Thinking" block; a reasoning-only round is salvaged as the reply rather than erroring. Each local-bridge thread owns an opaque resume pointer; the legacy column name is `claude_session_id`. Switching threads never bleeds task context. Both runtimes invoke the same propose-first Canvas tools, render verification, review gates, and cancellation states.

### Variant group (A/B slide variants)
Generate-compare-choose for one slide: the MCP tool `propose_slide_variants` inserts N sibling pending Edits sharing a `canvas_deck_edit.variant_group_id` (migrations 0066 + 0068). Picking the winner goes through `canvas_apply_variant` ONLY — it applies the chosen Edit and, in the same transaction, sweeps its pending siblings on that slide to `superseded` (not `rejected`, so they stay out of rejection analytics). A guard trigger makes the generic `canvas_apply_edit` refuse a grouped row (`variant_pick_required`), so a variant can never be applied while its siblings stay pending. The chatbox renders the pick-one card (keyed on `assistant_message_id`); the Review rail shows N cards whose approve is refused until the group resolves; terminal MCP clients get no special UI.

### Slide copy (slide library v0)
Cross-deck reuse of one Slide. The MCP tool `copy_slide` proposes a `new_slide` into the target deck with content read from a source slide the caller can access; provenance rides `new_slide_payload.source` (the apply path ignores it; it survives on the applied Edit as audit). Editors also get a direct UI path — the Copy-from-deck dialog in the editor. Copies carry the source's `slide_styles` but never its deck Theme, so a copy across unrelated themes may need a restyle.

### Pre-flight check
A deterministic render-and-audit pass before a deck ships (`/api/decks/{id}/preflight`; no migration — findings are derived and ephemeral, any edit invalidates them, so the dialog re-runs rather than caches). It rides the thumbnail rasterizer (`rasterizeDeckHtml` with `skipShots`) and reports what a client would see broken: text clipped mid-element (visible-rect intersection — the rule that keeps it from drowning in false positives), dead images, slide-JS errors. Findings carry a `severity` (`blocker` vs. warning) and a slide position to jump to. Soft by design: opened from the Export menu, it informs the export decision and never blocks it — a wall would just get routed around in the fast solo loop.

### Slide Version
An immutable, append-only row in `public.canvas_slide_version` capturing one historical state of a Slide. Every applied Edit (and every Restore) produces a new version with monotonic `version_no` per Slide and a `parent_version_id` pointer (linear today; the column is DAG-ready). Stores `title`, `html_body`, `slide_styles`, plus full attribution: `author_kind` (user / claude), `created_by`, `source_prompt`, and `source_edit_id`. Versions are the source of truth — `canvas_deck_slide.html_body` / `.slide_styles` / `.title` are denormalized fast-read caches, kept in sync by the apply-edit and restore RPCs. `canvas_deck_slide.current_version_id` points at the latest version.

### Deck Snapshot
A named frozen cut of the whole Deck. Stored in `public.canvas_deck_snapshot` (theme_css + nav_js + meta captured inline) plus `public.canvas_deck_snapshot_slide` (the (position → slide_version_id) map). Cheap to create — no content duplication beyond theme/nav. Snapshots are immutable; only admins can delete (intended for cleaning up old auto-snapshots, deferred to a cron migration).

Snapshot kinds (enum `public.canvas_snapshot_kind`):

| Kind | Trigger |
|---|---|
| `manual` | User clicks "Save snapshot" with a label |
| `pre_export` | Auto, just before an HTML download / share link is generated |
| `pre_share` | Auto, on the "Mark as sent to client" action |
| `pre_consolidate` | Auto, before a Consolidate (multi-slide AI rewrite) run |
| `pre_restore` | Auto, the safety net before any `canvas_restore_snapshot` call |
| `daily` | Cron at 00:00 if anything changed that day (future migration) |

Retention rule (future cron): `daily` snapshots older than 90 days may be pruned. All other kinds stay forever.

### Deck Activity (feed)
The "Activity" section at the top of `/canvases/{id}/history` — a chronological "who did what" feed ("Alice added slide 5", "Bob deleted slide 3"). It is DERIVED at read time (`app/src/lib/canvas/activity.ts`) from the tables that already record every action: `canvas_deck_edit` (proposals: applied/rejected/withdrawn/pending, proposer + approver), `canvas_slide_version` (restores + direct edits, classified by `source_prompt`), `canvas_deck_snapshot` (manual saves + the pre_export/pre_share auto-kinds doubling as export/share markers), and `canvas_comment`. One action needed a real log: slide deletion CASCADE-erases every trace (versions, comments, and the `slide_delete` proposal row itself), so migration 0037 added `public.canvas_deck_activity` — a small append-only table written by a BEFORE DELETE trigger on `canvas_deck_slide` (actor, proposer, slide title/position; soft refs only, errors swallowed so the audit can never block the delete). Today only `slide_delete` rows are written; the table is generic (`action` + `detail` jsonb) in case more events ever need durable storage.

### View telemetry / Engagement report
Anonymous recipient telemetry from the public viewer `/p/{token}` only — the deck iframe is an opaque origin, so the grain is slide *transitions*: opens and per-slide dwell, with the clock paused while the tab is hidden. Events batch to `/api/public/deck/{token}/track` and persist as `canvas_usage_event` rows with `surface='public'` (migration 0063 widens the surface check and adds a partial index — no new table). The session is an opaque localStorage id (`canvas:view-session`) — no cookie, no PII. Surfaced as the Engagement report at `/canvases/{id}/engagement` and an opens line in the share dialog. Present mode is never wired for it: the owner rehearsing is not a client reading.

## Versioning semantics

**Restores are never destructive.** `canvas_restore_slide_version(slide_id, to_version_id)` and `canvas_restore_snapshot(snapshot_id)` both work by **creating new versions** that copy content from the target. History stays linear forward. The audit trail always shows "Bernardo restored slide 3 to v5 → produced v9" — not a pointer move.

**Restore from snapshot auto-snaps first.** Before mutating anything, `canvas_restore_snapshot` calls `canvas_create_snapshot(..., 'pre_restore')` so the user can undo with one click.

**Slides deleted after a snapshot is taken are skipped on restore** (the snapshot's pointer is dangling; no attempt to recreate). UI should surface a warning. Recreating deleted slides is a v1.1 concern.

## RPC surface (DB functions, granted to `authenticated`)

| Function | Returns | Notes |
|---|---|---|
| `canvas_apply_edit(_edit_id uuid)` | `canvas_slide_version` | Atomically: inserts new version (for slide edits) or updates `canvas_deck.theme_css`/`nav_js` (for theme/nav edits), updates the slide's denorm + `current_version_id`, marks the edit `applied`. SECURITY INVOKER — RLS enforces who can apply. |
| `canvas_restore_slide_version(_slide_id, _to_version_id)` | `canvas_slide_version` | Forward-only restore; produces a new version. |
| `canvas_create_snapshot(_deck_id, _label, _description?, _kind?)` | `canvas_deck_snapshot` | `_kind` defaults to `manual`. |
| `canvas_restore_snapshot(_snapshot_id)` | `int` (slides restored) | Auto-creates a `pre_restore` snapshot first, then advances every slide forward. |
| `canvas_save_slide_direct(_slide_id, _new_html, _base_version_id?, _summary?, _release_lock?)` | `canvas_slide_version` | Direct (non-proposal) slide-HTML edit for an editor; versions the slide and aborts on a stale base (migration 0033). `_release_lock=true` deletes the caller's soft lock in the SAME transaction, so an inline save is one round-trip instead of save + a separate releaseSlide (migration 0072). |
| `canvas_create_slide_direct(_deck_id, _position, _title, _html_body, _slide_styles?)` | `canvas_deck_slide` | Direct insert at a position (shifts later slides right); backs "Draw a slide". `SECURITY DEFINER`, gated on `canvas_can_edit_deck` (migration 0061, ADR-0012). |
| `canvas_reorder_slides_direct(_deck_id, _order uuid[])` | `int` (slides reordered) | Direct position rewrite from an exact permutation; backs left-rail drag-to-reorder. Same DEFINER + `canvas_can_edit_deck` gate (migration 0061, ADR-0012). |
| `canvas_apply_variant(_edit_id, _expected_revision?)` | `canvas_slide_version` | The ONLY way to apply an Edit that belongs to a variant group: applies the pick and sweeps pending siblings to `superseded` in one transaction (migrations 0066/0068; see Variant group). |
| `canvas_save_slide_notes_direct(_slide_id, _notes)` | `void` | Writes `speaker_notes` for a slide the caller can edit; reserved for user-session writers (the MCP path is service-role and writes the column directly). Migration 0067. |
| `canvas_duplicate_slide_direct(_slide_id)` | `canvas_deck_slide` | Direct copy of a slide inserted right after its source (content verbatim, speaker notes NOT copied); backs the left-rail Duplicate for editors. Same DEFINER + `canvas_can_edit_deck` gate (migration 0071, ADR-0012). The in-app action falls back to the propose path for a member the gate refuses. |
| `canvas_delete_slide_direct(_slide_id)` | `int` (deleted position) | Direct delete + left-compact of positions; mirrors `canvas_apply_edit`'s slide_delete branch (only-slide guard, 0037 activity trigger fires). Backs the left-rail Delete for editors; propose path retained for others (migration 0071, ADR-0012). |

Plus the auto-trigger `canvas_deck_slide_init_version_trg` on insert into `canvas_deck_slide`, which creates `version_no=1` and points `current_version_id` at it. The import parser and the editor both get this for free.

## MCP tool surface for history (phase 3)

```
list_slide_versions(slide_id, limit)
read_slide_version(version_id)
diff_slide_versions(a_id, b_id)
list_snapshots(deck_id, limit)
read_snapshot(snapshot_id)
create_snapshot(deck_id, label, description?)
diff_snapshots(a_id, b_id)
```

These let Claude reason about history — *"slide 3 was best at v5, restoring"*, *"snapshot the deck before I touch CRM"*, *"here's what changed since the last client meeting"*.

## URL shape

Canvas uses a single global URL space — no `/w/{slug}/` prefix. Active workspace is resolved from the `canvas_active_workspace` cookie (or the user's oldest membership as a fallback); the topbar dropdown switches it. See `app/src/lib/auth/workspace.ts`.

- `/login` — Google + magic link
- `/canvases` — Deck list (active decks; `?archived=1` shows the archived shelf — see **Archived deck**)
- `/canvases/new` — Create / import
- `/canvases/{id}` — Editor (3-pane)
- `/canvases/{id}/present` — Full-screen presentation; shows the current slide's Speaker Notes to the presenter
- `/canvases/{id}/theme` — Edit shared CSS (admin/owner) (planned, not yet implemented)
- `/canvases/{id}/history` — Edit history
- `/canvases/{id}/engagement` — Engagement report for the deck's public link (opens, per-slide dwell)
- `/p/{token}` — Public, cookieless, read-only viewer for a single Deck ("anyone with the link"; `canvas_deck.public_share_token`)
- `/p/project/{token}` — Public, cookieless, read-only viewer for a whole Project — lists its decks, each rendered via `/api/public/project/{token}/deck/{deckId}/preview` (`canvas_project.public_share_token`, migration 0046)
- `/settings/workspace` — Workspace identity (rename + delete)
- `/settings/members` — Invite / change role / remove
- `/settings/brand` — Workspace Brand Kit (tokens + voice; admin/owner)
- `/settings/mcp` — Personal MCP setup
- `/api/mcp` — canonical bearer-authenticated streamable HTTP MCP endpoint
- `/api/mcp/{token}` — legacy token-in-path compatibility endpoint
- `/api/assistant/bridge/poll` · `/api/assistant/bridge/event` — the local `canvas-agent` bridge polls for queued prompts and streams replies here (authenticated with the user's MCP token; see ADR-0006)
- `/api/assistant/openrouter/run` — same-origin authenticated runner for a queued `execution_runtime='openrouter'` prompt; streams through the user's encrypted personal key and executes the Canvas tool registry server-side (ADR-0010)
- `/api/public/deck/{token}/preview` · `/track` · `/comments` · `/comment` — the cookieless APIs behind `/p/{token}`: deck render, view telemetry ingest, and the guest-comment list/post pair (list partitioned by the guest's `client_session`)
- `/api/decks/{id}/preflight` — authenticated render-and-audit run backing the Pre-flight check dialog
- `/no-workspace` — Landing for signed-in users with zero memberships; offers Create-workspace

## Roles

Inherited from 21x Platform. Canvas only distinguishes:

- **Member** — read all decks in workspace; edit slides they own (or unowned); create new decks; comment everywhere.
- **Admin / Owner** — edit any slide; edit deck theme; resolve any pending edit; force-release locks; delete decks/assets.

Theme editing and force-release of locks are admin-or-owner gated by UI convention; RLS enforces the same in mutations.

## Infrastructure

| Resource | Value |
|---|---|
| Supabase org | your own Supabase org |
| Supabase project | the reference deployment is `canvas-prod` — Canvas's own project (see ADR-0004 for the split) |
| Region | `us-east-1` |
| Postgres | 17 |
| Hosting | Domain: `canvas.21xventures.com` (TBD provider — Vercel likely) |
| Local dev port | `3001` |
| Schema | `public.canvas_*` tables (prefixed, not a separate Postgres schema — avoids the "exposed schemas" config step in Supabase Studio). Tenancy tables (`workspaces`, `users`, `workspace_memberships`, `workspace_invites`) sit in `public` without a prefix; they're a verbatim port of the workforce-management foundation. |
| Storage bucket | `decks` (created on first import; see TODO in migration 0001) |

Keys live in `app/.env.local` (gitignored). See `app/.env.example` for required vars.

### Google OAuth

Canvas owns its own OAuth client (separate from the old shared project, since the split). For production, the production app URL goes into Supabase Auth → Redirect URLs, and the callback `https://<your-project-ref>.supabase.co/auth/v1/callback` is wired into the OAuth client's redirect URIs; see ADR-0004 for the standalone history.

## Architectural decisions

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-product-shape.md) | Canvas is a sibling product, not a feature of 21x Platform — separate repo and distinct domain. (Originally also "shared Supabase" — superseded on that point by ADR-0004.) |
| [0002](docs/adr/0002-deck-decomposition.md) | The collaboration unit is the slide; theme + slides + nav are separate columns; the assembled HTML is a projection. |
| [0003](docs/adr/0003-mcp-byo-claude.md) | Users keep their Claude subscription; Canvas exposes operations via a per-user MCP URL. No AI inference cost on the server. |
| [0004](docs/adr/0004-canvas-standalone.md) | Canvas becomes a standalone product — own Supabase project, own auth, own workspaces. Supersedes the "shared Supabase project" decision from ADR-0001. |
| [0005](docs/adr/0005-versioning.md) | Per-slide immutable version log + named deck snapshots; restores are forward-only (never destructive); auto-snapshots at consolidate / export / share / restore + daily; theme history folded into snapshots. |
| [0006](docs/adr/0006-in-app-assistant-bridge.md) | In-app **Ask Claude** chatbox runs the user's local Claude Code (`claude -p`) via a `canvas-agent` bridge — the subscription stays on the user's machine (server-side use of subscription tokens is against Anthropic's terms). Canvas still runs zero inference; edits arrive as proposals into the review rail. Extends ADR-0003. |
| [0007](docs/adr/0007-assistant-threads.md) | The assistant gets **separate conversation threads** per `(deck, user)` instead of one flat stream: a `canvas_assistant_thread` table, `thread_id` on each message, and the Claude session id moved onto the thread so each resumes independently. "+ New conversation" gives a clean context per task (less stale-context clobber); delete is per-thread. Extends ADR-0006. |
| [0008](docs/adr/0008-assistant-turn-cancellation.md) | **Stop** an in-flight assistant turn (the Claude-app affordance). The bridge is blocked in its turn loop, so it runs a short `/api/assistant/bridge/cancel-check` poll and aborts on request; the turn settles to a new `canceled` status (kept separate from `error`, partial output preserved). Queued prompts cancel directly; a dead bridge is settled by the action itself. Migration 0053; bridge 0.2.0. Extends ADR-0006/0007. |
| [0009](docs/adr/0009-agent-agnostic-clients.md) | Public UI and MCP are provider-neutral; bearer MCP supports any compatible client, while the local bridge uses Codex or Claude Code adapters. Defines the render-gated, patch-only trusted fast lane and the compatibility meaning of legacy `claude` database names. |
| [0010](docs/adr/0010-dual-assistant-runtime.md) | **Ask agent** supports two isolated per-turn runtimes: the local bridge or server-side OpenRouter using the user's AES-256-GCM-encrypted personal API key. Both use the same Canvas tools, proposal/review gate, visual renders, Realtime stream, and Stop semantics. |
| [0011](docs/adr/0011-workspace-openrouter-key.md) | A workspace-level shared OpenRouter key, so members can use the server-side runtime without each configuring a personal key. Extends ADR-0010. |
| [0012](docs/adr/0012-draw-slides-and-direct-structural-ops.md) | **Draw a slide** (Excalidraw-style) stores the drawing as SVG in `html_body`, re-editable via an embedded `data-canvas-scene` — plain HTML, so it renders in preview/export/thumbnails unchanged. **Draw over slide** injects the same scene as a `canvas-draw-overlay` layer inside an existing slide's `<section>`; being a content edit, it saves through the inline-edit gate (direct or proposal), no migration. Structural ops **reorder** + **create** go DIRECT for deck editors via two `canvas_can_edit_deck`-gated `SECURITY DEFINER` RPCs (migration 0061); agents keep the propose path. Extends ADR-0002/0005. |
| [0013](docs/adr/0013-deck-archiving.md) | **Deck archiving** — `canvas_deck.archived_at` (nullable timestamp, migration 0074) shelves a deck from the deck browse/pick surfaces (`/canvases`, MCP `list_decks`, `list_projects` counts, copy-from-deck picker) without deleting it. Orthogonal to `status` and `visibility`, access-preserving (archived decks still open/edit/serve public links), reversible. Creator/admin-only, enforced in-code (`is_workspace_admin_or_owner`, like `setDeckAgentFastLane`); no new RLS/table and no agent write tool. Extends ADR-0002. |

(ADR docs are filled in as we land phases. 0001–0003 still live as stubs; 0004 was written when Canvas was split into its own project; 0006–0008 establish the local assistant, threads, and Stop; 0009 makes clients provider-neutral; 0010 adds the optional personal OpenRouter runtime; 0011 shares one OpenRouter key per workspace; 0012 adds drawn slides, draw-over-slide overlays + direct reorder/create; 0013 adds deck archiving.)
