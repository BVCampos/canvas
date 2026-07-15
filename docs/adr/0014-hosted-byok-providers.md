# ADR-0014 — Hosted BYOK providers (Anthropic and OpenAI alongside OpenRouter)

- **Status:** accepted
- **Date:** 2026-07-07
- **Extends:** ADR-0010 (dual assistant runtime) and ADR-0011 (workspace key)

## Context

The hosted assistant runtime (ADR-0010) runs Canvas chat on the server with the
user's own API key, but only accepted OpenRouter keys. Users who already hold a
direct Anthropic or OpenAI account had to mint a separate OpenRouter account and
re-fund it to use Canvas chat without the local bridge. The runtime itself is
provider-shaped only at one seam — the completion call; rounds, tool execution,
persistence, cancellation, and history windowing are provider-neutral.

## Decision

The hosted runtime is provider-neutral with **one provider per user** (and one
per workspace for the shared fallback key):

- `canvas_user_ai_provider_config.provider` and
  `canvas_workspace_ai_provider_config.provider` widen from `'openrouter'` to
  `('openrouter','anthropic','openai')` (migration 0076). A credential row is
  the pair (provider, key); switching provider replaces the key, never reuses
  it against a different API.
- The turn loop stays in the OpenAI-shaped message space. Only the completion
  call sits behind a driver seam (`completion-types.ts`):
  - **openai-compatible driver** — the original streaming fetch, parameterized
    by endpoint/auth/body/error copy. OpenRouter keeps its exact behavior
    (models fallback array, image-input 404 detection); OpenAI runs against
    `api.openai.com` with a single model id.
  - **anthropic driver** — the native Messages API via `@anthropic-ai/sdk`,
    NOT an OpenAI-compat shim: conversion happens at the boundary (tool_calls
    ↔ tool_use, parallel tool results merged into one user message, data-URI
    images to base64 sources) and the system block carries `cache_control` so
    the tools+system prefix caches across rounds. No sampling or thinking
    params are sent — the current Claude generation rejects them.
- The runtime id **`'openrouter'` is retained as the hosted-runtime
  discriminator** in `default_runtime`, `execution_runtime`, and the
  `/api/assistant/openrouter/run` route path. It now means "hosted API
  runtime" generically; the credential's `provider` column names the vendor.
  Renaming would be a data migration across every historical assistant message
  and a breaking route change for zero user-visible benefit. This naming debt
  extends ADR-0009's compatibility-interpretation list.
- The **vision relay stays OpenRouter-only**: it is an OpenRouter routing
  workaround (text-only models 404 whole rounds) and consults OpenRouter's
  model catalog. Anthropic/OpenAI rounds that fail on image input fall back to
  the existing strip-images path; the preset Claude and GPT models are
  vision-capable, so the relay has nothing to add there.
- Save-time validation is the source of truth for model ids: `GET
  /v1/models/{id}` against the vendor with the user's key. Comma-separated
  fallback lists remain OpenRouter-only and get a distinct rejection.

## Consequences

- Connections shows one "Hosted API key" card with a provider selector; the
  stored key's provider is displayed once configured.
- Adding a fourth vendor is a driver + registry entry + presets, no schema or
  route change (an OpenAI-compatible vendor is just a profile).
- The `assistant.openrouter.*` usage events and module names
  (`openrouter-config.ts`, `runOpenRouterTurn`) keep their legacy names;
  events now carry a `provider` prop for per-vendor analysis.
- Per-user there is exactly one hosted credential — configuring Anthropic
  discards a previously saved OpenRouter key (deliberate: no key ring UI, no
  ambiguity about which key a turn bills).
