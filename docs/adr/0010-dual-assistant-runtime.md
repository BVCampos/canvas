# ADR-0010 — Dual assistant runtime with personal OpenRouter keys

**Status:** accepted  
**Date:** 2026-06-29  
**Extends:** ADR-0006, ADR-0007, ADR-0008, ADR-0009

## Context

The in-deck **Ask agent** panel originally depended on a local `canvas-agent`
process. That remains the right path for users who want Codex or Claude Code to
run under their existing local authentication, but it has two practical limits:

1. the bridge must be installed and kept running on the user's machine; and
2. browser-only users cannot use chat from another device without that machine.

Users may already have an OpenRouter account and want to pay for API inference
with their own key. Canvas still needs to preserve the same proposal tools,
visual verification loop, review gate, private per-user threads, and Stop
semantics whichever execution path handles a turn.

## Decision

Canvas supports two explicit runtimes for every assistant message:

- `bridge` — the existing local `canvas-agent` bridge. Canvas stores no provider
  credential for this path.
- `openrouter` — a Canvas Route Handler calls OpenRouter with the signed-in
  user's personal, encrypted API key.

`canvas_assistant_message.execution_runtime` is immutable in practice (users
have no UPDATE policy) and is included in every claim/update predicate. The
bridge only claims `bridge` rows; `/api/assistant/openrouter/run` only claims an
authenticated user's `openrouter` rows. Each assistant reply inherits the same
runtime. This is the isolation boundary between the workers.

The user chooses a default in **Settings → Connections** and can switch the next
turn between Local and OpenRouter in the deck chat. Existing rows default to
`bridge`, preserving behavior across the migration.

## Credential handling

One personal OpenRouter configuration is stored per Canvas user in
`canvas_user_ai_provider_config`.

- The API key is validated against OpenRouter's current-key endpoint before save.
- A custom model must appear in OpenRouter's tool-calling + image-input model
  result. `openrouter/auto` is the recommended default because OpenRouter routes
  against the request's capabilities.
- The application encrypts the key with AES-256-GCM and a random 96-bit nonce.
  `CANVAS_CREDENTIAL_ENCRYPTION_KEY` is a dedicated base64-encoded 32-byte
  deployment secret. The envelope is versioned for future rotation/migration.
- The credential table has RLS enabled, no `anon`/`authenticated` policies, and
  no table privileges for those roles. Only the service role can read it, after
  the server has independently authenticated the request and re-scoped it to
  `user_id`.
- The browser receives only `key_hint`, model, default runtime, and validation
  timestamp. A saved key is never returned or logged.
- Missing/malformed encryption configuration fails closed; plaintext fallback
  is forbidden.

## OpenRouter turn lifecycle

The browser first uses the existing authenticated Server Action to enqueue a
prompt. It then POSTs only that message id to the same-origin OpenRouter route.
The route:

1. enforces same-origin, body shape, session authentication, RLS visibility,
   ownership, runtime, and a per-user rate limit;
2. atomically flips only `queued → running` and opens one `streaming` assistant
   row;
3. decrypts the user's credential server-side;
4. streams OpenRouter chat completions and writes cumulative text snapshots for
   Supabase Realtime;
5. executes the existing Canvas MCP tool functions directly with the same
   `{user_id, workspace_id}` authorization context and the exact assistant row
   id, so proposals link to the correct reply even when turns overlap;
6. sends render-tool JPEGs back to the model as base64 image inputs so visual
   inspection and the render-gated fast lane remain meaningful; and
7. settles both prompt and reply to `complete`, `error`, or `canceled` with
   terminal-state guards.

Tool calling is serial (`parallel_tool_calls: false`) and capped at 12 rounds.
Conversation history, tool text, render-image count, response text, and route
duration are bounded. Provider errors are mapped to user-safe messages; raw
request/provider payloads and credentials are never surfaced.

Stop settles OpenRouter rows immediately and sets `cancel_requested_at`; the
runner's watcher aborts the provider request. A late provider response cannot
overwrite the terminal rows. Local bridge cancellation remains ADR-0008's
poll-and-abort protocol.

## Consequences

- Browser-only chat works without requiring the local bridge.
- The local path remains fully supported and incurs no Canvas-side inference.
- Canvas now performs server-side inference only when a user explicitly chooses
  OpenRouter, and bills that user's own provider account.
- Deployments must provision and preserve
  `CANVAS_CREDENTIAL_ENCRYPTION_KEY`; losing it makes saved keys undecryptable and
  requires users to reconnect.
- OpenRouter turns hold a server request while they run. The route declares a
  five-minute maximum and bounds tool rounds; a future queue worker can replace
  this without changing the message/runtime contract.
- `provider_model` and provider-reported usage are stored on the private reply
  row for diagnostics and future user-visible usage reporting.

