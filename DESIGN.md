# 21x Canvas — design

> Agent-agnostic multiplayer editor for HTML decks. Teams keep the agent they already use; Canvas removes the copy-paste/merge dance by giving every MCP-compatible client one shared, propose-first deck model.

> **2026 client-model update:** Claude Code was the original design partner and
> remains a supported adapter, but is no longer the product boundary. Codex,
> Claude Code, and future MCP clients share the same tools, review semantics,
> connection status, and in-app bridge protocol. See ADR-0009. Historical
> examples below may use Claude Code to describe the original workflow.

---

## 1. Who this is for, this week

Your team is already building client HTML decks by:

1. Opening the `.html` file locally.
2. Firing up Claude Code in that directory.
3. Iterating on slides with Claude Code's edit tools.
4. Sharing the file via cloud drive / commits, hoping nobody else is editing the same block.

The pain is **not** "Claude doesn't have multiplayer docs" in the abstract. The pain is concrete:

- Two people open the same `proposta.html`, both run Claude Code, last save wins.
- Reviewing what someone changed = reading a `git diff` of one giant HTML file.
- No way to say "I'm working on slide 5, leave it alone for the next 30 min."
- Sharing a preview with someone who doesn't have the file is awkward.

Canvas is the smallest piece of infrastructure that fixes those four things **without making them leave Claude Code.**

---

## 2. v1 success criteria

Canvas v1 ships when a Canvas user on your team can do all of this end-to-end:

1. **Drop a real client deck (`deck.html`) into Canvas at `canvas.21xventures.com`** and see it decomposed into the right slides, with the theme intact, in under a minute.
2. **Open it in their browser** and see a faithful live preview that matches the original.
3. **Run `claude` locally with the Canvas MCP connector enabled** and have Claude Code see the live deck (read slides, read theme).
4. **Claim slide N**, ask Claude Code to edit it, watch Claude Code call `update_slide`, and see the change land in the web preview within seconds.
5. **Have a teammate work on a different slide in parallel** without stomping — slide locks prevent it.
6. **See history** — every change, who made it, when, with the Claude prompt that produced it. Click a prior version → see it. Restore → produces a new version (never destructive).
7. **Export** back to a single self-contained HTML file for the client.

If all 7 work for that deck, v1 is done. Everything else — comments, presence indicators, fancy diff queues, multi-workspace switching — is post-v1.

---

## 3. Out of scope for v1 (explicit)

These are real features but they're not what makes Canvas useful tomorrow. Build them only when v1 is being used and the team asks.

- **Live presence / cursors.** Slide-level locks are enough. No Y.js, no Realtime broadcasts in v1.
- **Multi-workspace switching is basic** (cookie-based active workspace, no `/w/{slug}/` URL prefix) — full switching is a v1.5 add.
- **Consolidate / multi-slide AI rewrite flow.** Manual snapshots cover the "I want a savepoint" case.
- **Sources (pinned PDFs/URLs).** Schema there, no UI yet. Claude Code can already read local files in the user's working dir — that's the v1 source-of-context model.
- **Branching (DAG history).** `parent_version_id` column is in place; UI doesn't expose. Linear forever-history is the v1 mental model.

---

## 4. How your team uses it tomorrow (the walkthrough)

```
User A                                          Canvas server               User B
─────────                                       ─────────────               ──────
upload deck.html   ──────────────────────────►  parse → decks/slides/assets
                                                bucket; create deck row
                                                slides 1..14 inserted →
                                                trigger creates v1 each;
                                                base64 images extracted
                                                to Storage, src= rewrites
◄──── deck URL                                  

open in browser  ──────────────────────────►   render live preview
"claim slide 3"  ──────────────────────────►   lock slide 3 (15min)
                                                                              open in browser
                                                                              "claim slide 8" ──► lock slide 8

claude code with                                                              claude code with
canvas MCP enabled                                                            canvas MCP enabled
"work on slide 3"                                                             "work on slide 8"
  → list_decks                                                                  → list_decks
  → read_slide(slide3_id)                                                       → read_slide(slide8_id)
  → read_theme(deck_id)                                                         → read_theme(deck_id)
  → (drafts)                                                                    → (drafts)
  → update_slide(slide3_id, ...)                                                → update_slide(slide8_id, ...)
                                                inserts v2 on slide 3;
                                                updates denorm; broadcasts;
                                                                                inserts v2 on slide 8

both web previews                              ◄────────────────────────────  refresh, both slides updated

at end of day:
"snapshot v1 — sent to client"
                                                creates canvas_deck_snapshot
                                                with kind=manual

export ──►                                      stitches theme + ordered
                                                slide HTML + nav into one
                                                self-contained .html file
```

The key shift: **the user's agent is the editor; Canvas is the collaboration server.** Existing agent muscle memory is preserved while Canvas adds shared state, slide-level boundaries, history, rendering, and review.

> **Update (post ADR-0006/0007): there are now two ways in, not one.**
> 1. **Bring your agent** — add the MCP token to Codex, Claude Code, or another streamable-HTTP MCP client.
> 2. **Drive it from the browser** — the in-app **Ask agent** chatbox can use the local `canvas-agent` bridge (Codex and Claude Code adapters today) or the user's encrypted personal OpenRouter key, with separate task threads per deck and a per-turn runtime switch.
>
> So the web app is no longer "read-only-ish": it is a full editing surface for the Ask-agent path. Onboarding branches on which runtime the user wants — start the local bridge once, or add a personal OpenRouter key. Naming both modes is what lets Canvas serve non-terminal users, which is the prerequisite for it being a product rather than a terminal-client accessory.

---

## 5. Architecture

### Repo layout

```
21x-canvas/
├── CONTEXT.md              ← domain glossary (the canonical vocabulary)
├── DESIGN.md               ← this file
├── README.md
├── docs/adr/               ← ADR-0001 …
└── app/
    ├── src/{app,lib,components}/   Next 16 App Router
    ├── src/proxy.ts                middleware (Next 16 convention)
    └── supabase/migrations/        0000 workspace foundation, 0001+ canvas schema
```

Canvas was originally a sibling of `21x-workforce-management` and shared its
Supabase project. After **ADR-0004** Canvas runs standalone — own project,
own auth, own tenancy tables. Workforce-management is no longer a runtime
dependency, just a documentation reference.

### Stack

| Layer | Choice |
|---|---|
| Frontend | Next 16.2 App Router + React 19 + Tailwind 4 |
| Auth | Supabase (Google SSO + magic link, own project — independent of workforce-management) |
| DB | Postgres 17 on your own Supabase project |
| Storage | Supabase Storage — `decks` bucket (assets extracted from imported HTML) |
| Tenancy | `public.workspaces` + `public.workspace_memberships`, ported from workforce-management's schema (see `supabase/migrations/0000_workspace_foundation.sql`) |
| Editor client | **Any compatible agent via MCP** — external bearer MCP or the in-app **Ask agent** panel through a local Codex/Claude adapter or personal OpenRouter API runtime. The web UI owns preview, locks, history, export, assistant threads, review, and direct Adjust-mode edits. |
| Hosting | Vercel, domain `canvas.21xventures.com` |
| Local dev port | `3001` |

### Why standalone, not a feature of workforce-management

- Different domain (Decks vs Proposals/Projects/Tasks).
- Different runtime concerns (HTML iframe preview, large blobs).
- Different deploy cadence — Canvas iterates fast; workforce shouldn't get dragged along.
- Now independent at the data layer too (ADR-0004): own `auth.users`, own workspaces. Cross-app linking (deck ↔ workforce client) is preserved as plain UUIDs on `canvas_deck.client_id` / `proposal_id` with no FK enforcement — the workforce-management app can still read those if needed.

### Why MCP, not a CLI or web editor

- Your team's hands are already in Claude Code. We add nothing they need to learn.
- Claude Code's terminal-side diff/approval UX is the first review pass; Canvas adds a cross-team review pass in the inbox for proposals from other people's Claude sessions.
- We never call a model provider API ourselves. Inference stays on the user's local provider account.
- MCP setup is a one-time connection per agent client; live use and bridge presence are reported separately.

---

## 6. Domain model

All tables live in `public` with a `canvas_` prefix (no separate Postgres schema). Every table carries `workspace_id` and is RLS-protected via `public.is_workspace_member` / `public.is_workspace_admin_or_owner`.

| Entity | Table | v1? | Notes |
|---|---|---|---|
| Deck | `canvas_deck` | ✓ | optional FK to workforce `clients` / `proposals` |
| Slide | `canvas_deck_slide` | ✓ | denorm cache + `current_version_id` pointer |
| Slide Version | `canvas_slide_version` | ✓ | **immutable, append-only**; full attribution |
| Deck Snapshot | `canvas_deck_snapshot` | ✓ | named frozen cuts |
| Snapshot ↔ Slide | `canvas_deck_snapshot_slide` | ✓ | (position → slide_version_id) map |
| Slide Lock | `canvas_deck_slide_lock` | ✓ | 15min soft lock |
| Asset | `canvas_deck_asset` | ✓ | images extracted from imported HTML, in Storage |
| MCP Token | `canvas_mcp_token` | ✓ | per-user, per-workspace secret |
| Personal AI provider config | `canvas_user_ai_provider_config` | ✓ | per-user OpenRouter key encrypted at the application layer; service-role only |
| Edit (proposal) | `canvas_deck_edit` | ✓ | Claude Code writes via `propose_slide_edit` / `propose_theme_edit`; review queue in `/canvases/inbox` + per-proposal diff view |
| Comment | `canvas_comment` | ✓ | threaded comments with `@mentions`, attached to proposals or slides |
| Source | `canvas_deck_source` | schema only | UI deferred to v2; Claude Code reads local files |

---

## 7. Versioning model

This is load-bearing for v1 (criterion 6 in section 2). All shipped in migration 0002.

### Invariants

1. **Versions are append-only.** `canvas_slide_version` rows never mutate. Every `update_slide` produces a new row with monotonic `version_no` per slide.
2. **Restores are forward-only.** `canvas_restore_slide_version` and `canvas_restore_snapshot` create new versions whose content copies from the target. Never overwrites.
3. **Snapshots are pointer sets.** `canvas_deck_snapshot` stores theme/nav inline (small) plus `(position → slide_version_id)` in `canvas_deck_snapshot_slide`. Cheap.
4. **Denormalized current state on `canvas_deck_slide`** (`html_body`, `slide_styles`, `title`, `current_version_id`) is a fast-read cache, kept in sync by the RPC functions.

### Auto-snapshot triggers (server-side)

| Kind | When |
|---|---|
| `manual` | User clicks "Save snapshot" with a label |
| `pre_export` | Just before an HTML download |
| `pre_restore` | Safety net before any `canvas_restore_snapshot` call |
| `daily` | (deferred) cron at 00:00 if anything changed |
| `pre_share`, `pre_consolidate` | (in schema; not auto-triggered in v1) |

### RPC surface (granted to `authenticated`, all atomic)

| Function | Effect |
|---|---|
| `canvas_apply_edit(_edit_id)` | Applies a pending edit (kept for v2 review flow). |
| `canvas_restore_slide_version(_slide_id, _to_version_id)` | Forward-only restore; new version. |
| `canvas_create_snapshot(_deck_id, _label, _description?, _kind?)` | Capture theme/nav + current_version_id of every slide. |
| `canvas_restore_snapshot(_snapshot_id)` | Auto-creates `pre_restore` snapshot, then advances every slide forward. |

Plus an `after-insert` trigger on `canvas_deck_slide` that auto-creates `version_no=1` for new slides.

**v1 history UI**: a single page `/canvases/{id}/history` listing snapshots + a per-slide history panel in the editor showing the version list. Click → preview → "Restore". That's it.

---

## 8. MCP design (the v1 interface)

User installs the Canvas MCP server once via the personal URL on `/settings/mcp`:

```
https://canvas.21xventures.com/api/mcp/{user_token}
```

In Claude Code, this is one block in `~/.config/claude/mcp.json` (or however Claude Code's MCP config is laid out today — we'll generate the snippet on the settings page). Once added, every `claude` session in any directory has the Canvas tools available.

The server resolves token → user → active workspace, then performs every operation as that user under standard RLS.

### v1 tools (the set that makes the walkthrough in §4 work)

```
# Discovery
list_decks()
get_deck(deck_id)                       # → meta + slide list (titles, owners, lock state, current version_no)
read_slide(slide_id)                    # → {title, html_body, slide_styles, current_version_no}
read_theme(deck_id)                     # → theme_css (read-only context)
read_full_deck(deck_id)                 # → assembled HTML (read context for cross-slide work)

# Editing (propose → review → approve cycle)
propose_slide_edit(slide_id, {title?, html_body?, slide_styles?}, source_prompt?)
propose_theme_edit(deck_id, theme_css, source_prompt?)
list_proposals(deck_id?, slide_id?, status?)
get_proposal(edit_id)
comment_on_proposal(edit_id, body, mentions?)
withdraw_proposal(edit_id)

# Locks
lock_slide(slide_id)                    # 15min sliding
release_slide(slide_id)

# History
list_slide_versions(slide_id, limit?)
read_slide_version(version_id)
list_snapshots(deck_id, limit?)
create_snapshot(deck_id, label, description?)
```

Edits go through a propose → approve cycle: Claude Code calls `propose_slide_edit` / `propose_theme_edit`, which inserts a `canvas_deck_edit` row with `status='pending'`. The slide owner (or a workspace admin/owner) reviews the diff in the Canvas UI — the inbox at `/canvases/inbox` and the per-proposal page at `/canvases/{id}/proposals/{editId}` — and clicks Approve or Reject. Approval calls `canvas_apply_edit`, which produces a new immutable slide version and updates the denorm cache. The terminal-diff design was the original intent; the implementation evolved to add cross-team review because the same deck typically has multiple people (and multiple Claude sessions) touching it.

v2 adds: `add_source`, `reorder_slides`, `add_slide` / `delete_slide`, `diff_*`, and richer comment/reply tools.

### What Claude Code sees in practice

A user runs `claude` in any dir and says *"work on slide 3 of the client deck — tighten the panorama section."* Claude Code:

1. `list_decks()` → finds the client deck.
2. `get_deck(deck_id)` → sees slide 3 is "Panorama de Mercado", currently unlocked, current v=4.
3. `lock_slide(slide3_id)`.
4. `read_slide(slide3_id)` + `read_theme(deck_id)`.
5. Drafts a tightened version. Shows the diff in the terminal.
6. `propose_slide_edit(slide3_id, {html_body: '<section ...>...'}, source_prompt: 'tighten panorama section, kept the chart')`.
7. The slide owner (or an admin/owner) opens the proposal in the Canvas inbox, reviews the diff, and clicks Approve. Server inserts v5, updates denorm, broadcasts. Web preview updates.

When the user closes the chat, the lock expires after 15 min and the slide is free again.

---

## 9. Roadmap to v1 (≈ 5–7 days of focused work)

| Phase | Scope | Status |
|---|---|---|
| **0** | Scaffold + auth + schema 0001 (8 tables) | ✅ |
| **0.5** | Versioning (schema 0002 + 4 RPCs + auto-init trigger) | ✅ |
| **1** | Import parser: `teste.html` → theme + slides + assets-to-Storage | next |
| **2** | Read-only deck page: 3-pane layout (slide list / iframe preview / minimal sidebar with lock + version_no), no editing in the web UI yet | |
| **3** | MCP server: `/api/mcp/[token]/...`, the 17 v1 tools, token issuance + "Add to Claude" instructions on `/settings/mcp` | |
| **4** | History UI: per-slide version panel + `/canvases/{id}/history` snapshot list with Restore | |
| **5** | Dogfood on a live client deck with the team + iterate on whatever breaks | |
| **6** | Export: stitch theme + slides + nav back into a single self-contained HTML file (or zip with `/assets/` if we want to keep images external) | |

That's v1. Comments, presence, diff queues, multiplayer cursors all come after the team has been using v1 for a week and we know what actually hurts.

---

## 10. Decisions taken so far

1. **Name + domain** — `21x-canvas`, `canvas.21xventures.com`.
2. **Tenancy** — share `public.workspaces`; canvas tables FK in.
3. **Schema location** — `public.canvas_*` (prefix, not separate Postgres schema).
4. **Primary client** — **agent via MCP** (external bearer MCP, the in-app local bridge, or user-keyed OpenRouter). Canvas never holds a subscription credential; an optional API key is encrypted and used only for that user's chosen API turns. The web app does preview + history + locks + export + conversation + review + Adjust-mode direct edits.
5. **Editing model** — Claude Code calls `propose_slide_edit` / `propose_theme_edit`; the slide owner (or workspace admin/owner) approves the diff in the Canvas inbox before content lands. Terminal diff is still the first review pass; the inbox is the second, cross-team pass.
6. **Versioning** — per-slide immutable log + named deck snapshots; restores forward-only; theme history folded into snapshots.
7. **Branching** — linear (`parent_version_id` column DAG-ready; UI hidden).
8. **Auto-snapshots in v1** — `pre_export` + `pre_restore` only. `manual` available via UI. `daily` deferred.
9. **Multiplayer transport** — slide-level soft locks (15min). No Y.js, no live cursors.
10. **MCP** — BYO agent account; per-user, per-workspace token. Tools cover discovery, sources, render, propose/review, locks, comments, and history.

---

## 11. Open decisions to resolve before/during phase 1

- ~~**Hosting** — Vercel or self-host?~~ Resolved: Vercel, `canvas.21xventures.com`.
- **MCP config format for Claude Code** — generate a copy-pasteable snippet on `/settings/mcp` based on the current Claude Code MCP spec. Need to confirm the exact JSON shape on the day we build phase 3.
- **Export format** — single self-contained HTML (base64 images re-inlined) for "send to client" simplicity, or `.zip` with external `/assets/` for size? Probably both, picked at export time.
- **Asset GC** — `canvas_deck_asset` rows cascade on deck delete, but the Storage blobs don't. Add a `before delete` trigger or a janitor job — pick one before phase 1 since the importer writes lots of assets.

---

## 12. Reference

- **Supabase project**: the reference deployment is `canvas-prod` — see ADR-0004 for the split from the old shared platform project.
- **Workforce-management repo**: the internal sibling project whose conventions were originally mirrored here; the two are now independent at the data layer.
- **Source example deck**: a real client proposal (14 slides, ~560KB, base64 images), used as the import/parser test case. Kept out of the repo (gitignored) — synthesize your own from any HTML deck.
- **Migrations applied**:
  - `0001_canvas_schema` — 8 core tables + RLS
  - `0002_canvas_versioning` — 3 history tables + 4 RPCs + auto-init trigger
