# ADR-0007 — Separate conversation threads for the in-app assistant

- **Status:** Accepted (2026-06-16)
- **Extends:** [ADR-0006](0006-in-app-assistant-bridge.md) (the in-app Ask-Claude chatbox + local bridge). Does not change ADR-0006's core: Canvas still runs zero inference, the bridge still executes `claude -p` on the user's machine under their own subscription.

## Context

0041 gave the Ask-Claude chatbox **one flat conversation per `(deck, user)`**. Two things followed from that single stream, and both make it harder to "just do changes":

1. **Every new ask drags the whole prior conversation.** The bridge resumes the *latest* `claude_session_id` for the deck, so switching from "tighten slide 3" to "make the theme darker" keeps Claude carrying the slide-3 context. That is slower, more token-heavy, and the setup behind the stale-context clobbers we already see — Claude rewrites from a context that has moved on.
2. **The only way to get a clean slate is destructive.** "Clear" deleted *every* row for the `(deck, user)`. Starting fresh meant losing all history.

The ask from the product owner: let the assistant have separate threads "so it's easier to just do changes."

## Decision

Split the single stream into **threads**. A conversation is a `canvas_assistant_thread` row scoped to a `(deck, user)`; every prompt/reply carries its `thread_id`. The **Claude (Agent SDK) session id moves from the message onto the thread**, so each thread resumes its own conversation and switching threads never bleeds one task's context into another.

The headline interaction is **"+ New conversation"**: a fresh, cleanly-scoped thread. The thread row is *born on the first send* (and titled from that prompt), so abandoning a blank "new conversation" costs nothing — empty threads never pile up. "Clear" becomes **delete *this* thread** (its messages cascade), not blow-away-everything.

This is deliberately the smaller of the two shapes we considered (see "Why not the alternatives"): threads organize the *input* only. Proposals, the review rail, comments, and the decision strip stay the single consolidated output surfaces — we don't re-fragment what the UI-clarity work just unified.

### Shape

- **`canvas_assistant_thread`** — `(deck_id, workspace_id, user_id, title, claude_session_id, created_at, updated_at)`. `title` is auto-derived from the first prompt (no rename UI in v1). `claude_session_id` is the resume pointer, written by the bridge on a turn's finish.
- **`canvas_assistant_message.thread_id`** — NOT NULL FK, `on delete cascade`. The per-`(deck,user)` session index/column on the message is dropped; the session now lives on the thread.
- **Poll** claims a queued prompt, reads its `thread_id`, and looks the resume pointer up on **that thread** — independent per thread. The bridge also keeps an in-process `Map<thread_id, sessionId>` so two turns of the same thread claimed in one poll batch still chain correctly.
- **Event/finish** persists `session_id` onto the thread row (best-effort — a lost pointer only costs a cold restart, it must not strand the row). The assistant reply inherits its prompt's `thread_id` from the row, so the bridge can't misroute it.
- **Web UI** — a header switcher (always-visible thread title + ▾ popover of recent conversations) and a "+ New" button, in the chat panel's existing header row, so threads cost no extra rail height. Hydrate + realtime are scoped to the active thread; a second realtime subscription keeps the switcher list live.
- **RLS** — `canvas_assistant_thread` is private per `(deck, user)`: the user reads/creates/deletes their own; no UPDATE for authenticated (title set at insert; session id + `updated_at` written by the bridge/service role + triggers). The prompt-insert policy is tightened to require the `thread_id` belong to the user on the same deck.

### Why not the alternatives

- **A full thread *manager* (named, pinned, persisted threads; a tabs strip or a persistent rail list).** The right rail is already cramped (Activity stacked above a collapsible chat in a ~300px column, plus a mobile bottom-sheet). Tabs/lists cost width and a persistent row of height the rail doesn't have. Auto-titled threads in a header popover get ~all of the value for none of the chrome; naming/pinning can come later if anyone asks.
- **Scope a thread to a slide.** The assistant proposes theme / reorder / deck edits too, not just slide edits — per-slide threads would lie about what Claude can touch and multiply threads by slide count. A thread is about a *task*, which often spans slides.
- **Concurrent / parallel threads (run two at once).** The bridge is a single local `claude -p` loop and the review queue is one queue; true parallelism is a separate, larger change. Out of scope here — the session-per-thread model doesn't preclude it later.
- **Keep one thread, just add a non-destructive "New".** That *is* most of this ADR — but without `thread_id` you can't reopen the old conversation or resume it cleanly, so the thread row is the minimal honest model.

## Consequences

- **Less stale-context clobber, cheaper turns.** A fresh thread starts Claude cold instead of replaying an unrelated transcript.
- **History survives.** "New conversation" archives-by-keeping rather than deleting; delete is now a deliberate per-thread act.
- **Migration touches live rows.** 0042 backfills one thread per existing `(deck, user)`, titled from its first prompt and seeded with that conversation's latest session id, then sets `thread_id` NOT NULL and drops the old message-level session column/index.
- **Cross-thread bleed is the bug to watch.** The message hydrate/realtime are now `thread_id`-scoped and we wipe the message list on every thread switch (render-phase, not in an effect); fail-closed on `user_id` is unchanged.

## Status of implementation

- `0042_canvas_assistant_threads.sql` — `canvas_assistant_thread` (+ RLS + realtime + `updated_at`/bump triggers); `thread_id` on `canvas_assistant_message` with backfill; session column/index moved to the thread; tightened prompt-insert policy.
- `src/app/api/assistant/bridge/poll/route.ts` — claim returns `thread_id`; resume pointer read from the thread row.
- `src/app/api/assistant/bridge/event/route.ts` — assistant rows inherit `thread_id`; finish persists `session_id` onto the thread.
- `bridge/canvas-agent.mjs` — per-thread session map for same-batch chaining; resumes from the thread's session.
- `src/app/canvases/[id]/assistant-actions.ts` — `sendAssistantMessage(deckId, threadId, text)` (creates + titles the thread on first send); `deleteAssistantThread`.
- `src/app/canvases/[id]/assistant-panel.tsx` — thread switcher + "+ New" in both shapes; thread-scoped hydrate/realtime.
- Tests: `assistant-thread-poll.test.ts` (per-thread resume); existing poll-claim / event-ownership / bridge-auth still green.
