# ADR-0008 — Stop an in-flight assistant turn

- **Status:** Accepted (2026-06-25)
- **Extends:** [ADR-0006](0006-in-app-assistant-bridge.md) (the in-app Ask-Claude chatbox + local bridge) and [ADR-0007](0007-assistant-threads.md) (threads). Does not change the core: Canvas still runs zero inference, the bridge still executes `claude -p` on the user's machine under their own subscription, edits still arrive as proposals.

## Context

A running assistant turn could only end on its own (`finish`/`error`) or hit the bridge's 120s wall-clock timeout. There was **no way to stop one** — the affordance every Claude surface has (Esc / the Stop button). A turn that's going the wrong way, or is slowly chewing tokens on a misread, just had to be waited out.

The hard constraint is the bridge's shape: while a turn runs it is **blocked in its `for await (query)` loop** (`bridge/canvas-agent.mjs`) and is *not* polling. The normal poll (which claims new prompts) only runs between turns, so a Stop signal has no path into the running turn through it.

## Decision

Give the chatbox a **Stop button** (where Send sits, shown only while a turn is in flight) and a path for it to reach the running turn:

1. **Stop request (web → DB).** A `cancelAssistantTurn(deckId, threadId)` server action records the intent. In-flight rows have no authenticated UPDATE policy (they're mutated only by the service-role path, as 0041/0042 established), so the action verifies the user owns the thread and then writes through the **admin client**, re-scoped to that thread + user. A new nullable column `canvas_assistant_message.cancel_requested_at` carries the request on the in-flight `user` row.
2. **In-turn cancel poll (bridge → DB).** Because the turn loop is blocked, the bridge runs a **separate short interval** (`CANCEL_POLL_MS`, default 1.2s) that POSTs `/api/assistant/bridge/cancel-check {user_message_id}` and, on a pending stop, fires the turn's existing `turnAbort` controller. The endpoint is read-only and ownership-gated; it just reports `cancel_requested_at != null`.
3. **Settle as a distinct terminal state.** The aborted turn is reported with a new `canceled` bridge event (carrying the partial text streamed so far). The server settles both the prompt and reply rows to a new `'canceled'` status — **kept separate from `error`** so the chatbox shows the partial output under a muted "Stopped" label, not a red failure. `canceled` joins `complete`/`error` as a terminal state, and all settle paths (finish / error / the poll reaper) are made **mutually exclusive — first terminal wins** — so a direct-cancel and a late finish can't clobber each other.

### Two shapes the action handles

- **Queued prompt, never started** → flip straight to `canceled` (no bridge turn to interrupt).
- **Running turn** → if the user's bridge is **online** (fresh `canvas_assistant_bridge_presence`, same 8s threshold as the presence dot), set `cancel_requested_at` and let the bridge abort + settle (so the partial reply is preserved). If the bridge is **offline**, nothing would ever settle the row, so the action settles the in-flight rows directly — Stop is never a silent no-op.

## Why not the alternatives

- **Piggyback the cancel flag on the existing `delta` response.** Zero new endpoints, but deltas only fire on output — during a long tool call or silent model thinking, Stop would lag many seconds (up to the timeout). A dedicated ~1.2s poll makes Stop feel instant in *every* phase. (A hybrid of both was considered and rejected as two mechanisms for one job.)
- **Reuse the `poll` endpoint mid-turn.** `poll` claims queued rows, writes presence, and reaps — heavyweight and side-effectful; wrong to call at high frequency inside a turn. `cancel-check` is a minimal read.
- **Let the bridge keep no extra state and just kill the process.** That strands every other in-flight thread for the user and loses the partial output. Aborting the single turn's controller is surgical.
- **Reuse `error` for a stop.** A stop is intentional, not a failure — flashing red + a Retry-as-error misreads what happened. `canceled` keeps the partial reply and reads as "Stopped".
- **An Esc keybinding.** Deferred — Esc already maps to close-menu / close-floating-panel / leave-pick-mode in this surface, so a clean binding is its own change. Button only for now.

## Consequences

- **New migration touches the live table.** `0053` adds `cancel_requested_at` and widens the status CHECK to include `canceled`. CI does not migrate — it must be applied to prod **before** the new bridge/server code ships, or a `canceled` write violates the old CHECK.
- **Bridge version bump (0.1.0 → 0.2.0).** Stopping a *running* turn needs the new bridge. An old bridge won't poll `cancel-check`, so Stop on its in-flight turns falls back to the offline/reaper path (the presence dot already nudges "update available"). Queued-prompt cancel works regardless of bridge version.
- **Stop is thread-scoped**, not a global "stop all my turns", and terminal — resuming continues via a fresh prompt on the same thread (the thread's Claude session is unchanged, so context carries over). No pause/resume.
- **Extra request traffic only during a turn**: ~1 small `cancel-check` per 1.2s per in-flight turn (≤ `CANVAS_MAX_CONCURRENT_THREADS`), rate-limited at 300/60s.

## Status of implementation

- `0053_canvas_assistant_cancel.sql` — `cancel_requested_at` column; status CHECK widened with `canceled`; partial index for the cancel-check lookup.
- `src/lib/canvas/assistant/bridge-events.ts` — `BridgeCanceledEvent` added to the union + parse.
- `src/app/api/assistant/bridge/event/route.ts` — `handleCanceled` (settles both rows, keeps partial content); finish/error guards widened so terminal states are mutually exclusive.
- `src/app/api/assistant/bridge/cancel-check/route.ts` — new read-only, ownership-gated, rate-limited endpoint.
- `bridge/canvas-agent.mjs` — in-turn cancel poll + `canceled` settle in the catch; `CANCEL_POLL_MS`; version 0.2.0.
- `src/app/canvases/[id]/assistant-actions.ts` — `cancelAssistantTurn` (queued→canceled; running→request-or-direct-settle by bridge presence).
- `src/app/canvases/[id]/assistant-panel.tsx` — Stop button (replaces Send while in flight); `canceled` rendering with a "Stopped" tag + Retry; `LATEST_BRIDGE_VERSION` 0.2.0.
- Tests: `db/canvas-assistant-cancel` (migration), `assistant-cancel-check` (endpoint), extended `assistant-event-*` (canceled settle + exclusivity) and `assistant-actions` (the action's branches); `bridge-version-sync` kept green.
