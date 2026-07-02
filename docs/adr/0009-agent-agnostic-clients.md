# ADR-0009 — Agent-agnostic clients and local adapters

- **Status:** accepted
- **Date:** 2026-06-28
- **Extends:** ADR-0003 and ADR-0006–0008

## Context

Canvas began with Claude Code as the only editing client. That proved the
propose-first model, but provider names leaked into product copy, connection
status, the local bridge, and historical database discriminators. Users should
be able to bring the agent they already use without Canvas pretending that a
token is a live connection or requiring a provider-specific workflow.

## Decision

Canvas is agent-agnostic at every public boundary:

- The canonical endpoint is streamable HTTP MCP at `/api/mcp` with a bearer
  token. `/api/mcp/{token}` remains as a compatibility endpoint.
- MCP `initialize.clientInfo` is recorded as last-seen client metadata and is
  used for truthful connection status, never as an authorization decision.
- The in-app panel is **Ask agent**. The local `canvas-agent` bridge chooses an
  adapter with `CANVAS_AGENT_PROVIDER`; v1 adapters are Codex and Claude Code.
- Canvas runs no inference and stores no provider credential. Each adapter uses
  the user's local provider authentication.
- MCP tools, proposal review, comments, versions, and audit attribution use the
  same protocol and semantics for every provider.

Historical database values such as `proposed_by_kind='claude'`,
`author_kind='claude'`, and `claude_session_id` remain temporarily. They now
mean “agent-authored” or “opaque provider resume id.” Renaming persisted enums
and columns would be a high-risk migration with no user-visible benefit; new UI
and API language must not expose the legacy label.

## Trusted fast lane

Propose-first remains the default. A narrow fast lane is allowed only when:

1. workspace self-approval is enabled;
2. the deck creator/admin opts that deck in;
3. the proposal came from deterministic `propose_slide_patch` or
   `propose_deck_patch` processing;
4. `render_proposal` completed successfully; and
5. the caller owns the deck/slide or is a workspace owner/admin.

The agent then calls `apply_trusted_proposal`. Full rewrites, structural edits,
theme changes, unrendered proposals, and non-owner changes always wait for a
human reviewer.

## Consequences

- Connections has separate, live status for external MCP use and the local
  in-app bridge.
- Provider adapters can be added without changing deck or proposal APIs.
- Some internal legacy names remain and require a documented compatibility
  interpretation.
- Bridge releases must keep their MCP tool allowlist in sync with the server
  registry and report a provider/version heartbeat.

