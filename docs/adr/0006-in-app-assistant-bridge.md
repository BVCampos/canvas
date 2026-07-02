# ADR-0006 — In-app assistant via a local Claude Code bridge

- **Status:** Accepted (2026-06-16)
- **Supersedes / relates to:** extends [ADR-0003](0003-mcp-byo-claude.md) (BYO-Claude over MCP). Does **not** change ADR-0003's core: Canvas still runs zero AI inference server-side.

## Context

We want an assistant chatbox **inside** the Canvas web UI: a user types "tighten the
headline on slide 3" and it happens, without leaving the app for a separate Claude
Code terminal. The collapse of that context-switch is the whole point — "make the
platform faster in terms of actions."

The obvious implementation is to run **headless Claude Code** (`claude -p`, i.e. the
`@anthropic-ai/claude-agent-sdk` `query()` function) **server-side** in Canvas's
backend, authenticated with each user's own Claude **subscription**, with the
existing Canvas MCP server wired in so Claude can call `propose_slide_patch` and
friends.

The Agent SDK supports everything that requires technically:

- `query({ prompt, options })` streams assistant/tool events and supports multi-turn
  `resume`.
- `options.mcpServers: { canvas: { type: "http", url: ".../api/mcp/<token>" } }` wires
  in our existing remote HTTP MCP server unchanged.
- `permissionMode: "dontAsk"` + `allowedTools` auto-runs our allowed tools and
  auto-denies the rest with no interactive prompt — headless-safe, and without the
  full-bypass acknowledgement `"bypassPermissions"` would demand. (The shipped
  bridge does NOT set `allowDangerouslySkipPermissions`.)
- The bridge inherits the user's ambient Claude Code credentials; it sets NO auth
  env of its own. Passing `options.env` would replace the whole subprocess env (not
  merge), breaking PATH/HOME and the inherited login — so the local subscription is
  used as-is.

## The blocker

**Anthropic's terms forbid using a user's Pro/Max subscription OAuth token in a
product, tool, or service — explicitly including the Agent SDK.** Per the Claude Code
authentication docs, subscription OAuth tokens (`claude setup-token` /
`CLAUDE_CODE_OAUTH_TOKEN`) are licensed for the user's **own** use; the only carve-out
is personal CI on your own repo where you're the sole contributor. A multi-tenant
Canvas backend that runs *users'* subscription tokens to serve *their* requests is
squarely outside that, and risks getting those Anthropic accounts banned.

The sanctioned path for *server-side* programmatic use is an **API key** (billed
per-token) — but the product requirement is explicitly "users authenticate with their
own **subscription**," and Canvas's thesis (ADR-0003) is "no server-side inference
cost." A server-side API key (Canvas's or the user's) satisfies the ToS but not the
requirement.

## Decision

**Run `claude -p` on the user's own machine, not on Canvas's server.** The Canvas web
chatbox is a thin front-end; a small local **bridge** the user runs (`canvas-agent`)
does the actual inference under the user's own subscription, on the user's own
hardware. The subscription token never leaves the user's laptop, and Canvas remains a
zero-inference service.

This is the only way to satisfy *both* hard constraints — "user's own subscription"
**and** the ToS — and it is a natural evolution of ADR-0003 (users already run Claude
Code locally against the Canvas MCP; we're adding a web-triggered surface for it).

### Shape

```
 Canvas web UI  ──user msg──►  canvas_assistant_message (queued)
       ▲                                   │
       │ realtime (RLS: own rows)          │  POST /api/assistant/bridge/poll?token=<MCP token>
       │                                   ▼
       └──assistant msg◄── POST /api/assistant/bridge/event ──┐
                                                              │
                              ┌───────────────────────────────┘
                              │  canvas-agent (user's machine)
                              │   • claude -p via @anthropic-ai/claude-agent-sdk
                              │   • auth: user's OWN subscription (local creds)
                              │   • mcpServers.canvas → user's own /api/mcp/<token>
                              │   • streams text back via bridge/event
                              └──► proposes edits over MCP → existing review rail
```

- **Reuses the per-user MCP token** for bridge auth — no new secret. The bridge
  endpoints resolve `token → user → workspace` exactly like `/api/mcp/[token]`.
- **Reuses the proposal flow**: the bridge's Claude proposes via the same MCP tools;
  edits land in the existing review rail for one-click human approval. Propose-first
  (ADR-0002/0003) is preserved — the chatbox makes proposals appear *instantly* in the
  rail; it does not auto-apply.
- **Reuses Supabase Realtime**: `canvas_assistant_message` is published; the web UI
  renders the conversation live (RLS scopes each user to their own thread).
- **Session continuity** via the Agent SDK's `resume` — the `claude_session_id` lives
  on the *thread* (per-thread resume; ADR-0007 / migration 0042), so switching
  conversations never drags one task's context into another. The active thread's
  session id is handed back to the bridge on poll.

### Why not the alternatives

- **Server-side subscription token** — prohibited (the blocker above).
- **Server-side API key (Canvas-paid)** — ToS-clean but reverses ADR-0003 (real COGS,
  server inference). Viable future "managed" tier, not the default.
- **Server-side API key (user BYO key)** — ToS-clean and zero Canvas cost, but it's an
  API key, not the subscription the requirement names, and most subscription users
  don't have one. Kept as a documented fallback the bridge also accepts
  (`ANTHROPIC_API_KEY`), but not the headline path.

## Consequences

- Users must run a local process (`npx @21xventures/canvas-agent` with their MCP token).
  This is the same footprint as today's MCP setup, and once running the whole loop is
  driven from the web UI. The bridge is published **privately** to GitHub Packages
  (scope `@21xventures`, inherits this repo's visibility), so there's no clone — `npx`
  fetches it; org members authorize once with a `read:packages` token in `~/.npmrc`.
  Release bumps the bridge version and the app's `LATEST_BRIDGE_VERSION` pin together
  (`scripts/release-bridge.mjs`, guarded by `bridge-version-sync.test.ts`); a
  `canvas-agent-v*` tag triggers `.github/workflows/publish-bridge.yml`.
- Canvas pays nothing for inference and never holds a Claude credential. The blast
  radius of a Canvas breach does not include anyone's Anthropic account.
- "Offline" is a first-class state: if the bridge isn't running, queued messages sit
  until it reconnects; the UI shows bridge status.
- The bridge is a separate package (`bridge/`) so it never bloats the Next app bundle.

## Status of implementation

- `0041_canvas_assistant.sql` — `canvas_assistant_message` (+ RLS + realtime).
- `0042_canvas_assistant_threads.sql` — per-task threads; the Agent SDK session
  moves onto the thread (ADR-0007).
- `0043_canvas_assistant_proposal_link.sql` — `canvas_deck_edit.assistant_message_id`,
  the link from a proposal to the chatbox turn that produced it (see below).
- `0044_canvas_assistant_bridge_presence.sql` — a per-user bridge heartbeat so the
  panel shows an online/offline dot instead of inferring from a stalled turn.
- `src/app/api/assistant/bridge/{poll,event}/route.ts` — bridge endpoints (MCP-token
  auth, service-role writes); `poll` also stamps the presence heartbeat.
- `src/app/canvases/[id]/assistant-panel.tsx` + `assistant-actions.ts` — web chatbox.
- `bridge/` — the `canvas-agent` CLI.
- `/settings/mcp` — "Run the in-app assistant" card with the start command.

### Extension — review the gate inside the panel (2026-06-16)

The chatbox originally dropped proposals into the review rail and told the user to
go there. To make editing genuinely faster we surface a turn's proposals **inline,
under its reply bubble**, with one-click Approve/Reject and a post-approve Undo —
so the user never leaves the panel. Propose-first is unchanged (this is still a
*gate*, just a closer one); approval is **not** auto-applied.

How it stays one code path (no second approve surface — the UI-clarity
one-act-one-path rule): the MCP `propose_*` handlers stamp each `canvas_deck_edit`
with the caller's live (`streaming`) assistant reply (`assistant_message_id`, 0043)
when a chatbox turn is in flight; every other propose path (terminal Claude, no
live turn) leaves it null and is unaffected. The panel reads those linked rows and
renders Approve/Reject/Undo that call the **same** server actions the review chip
uses (`approveProposal` / `rejectProposal` / `revertProposal`). The link is
write-once (frozen by the immutability trigger created in 0007; 0043 recreates that
trigger's FUNCTION to allow only `→ null` for the FK's on-delete-set-null), so a
member who can UPDATE the row can't re-point a proposal into someone else's panel.
On approve the panel reveals the touched slide so the result shows in place.

Each card also carries a **Compare** control that drives the chip's existing Lens
(deck-workspace's `compareProposal`): first click reveals the slide and lenses the
proposed version into the preview, repeat clicks wipe current↔proposed ("go back and
forth"), non-lensable kinds fall back to the diff sheet. Same Lens, no duplicate diff
renderer — the card is just another way in.
