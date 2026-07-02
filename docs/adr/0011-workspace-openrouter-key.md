# ADR-0011 — Workspace-shared OpenRouter key

**Status:** accepted
**Date:** 2026-06-29
**Extends:** ADR-0010

## Context

ADR-0010 stores one OpenRouter configuration **per user**. That makes every
member set up their own key before they can use the server-side runtime — fine
for individuals, friction for a team that wants to try the cloud runtime
(e.g. GLM) without each person creating an OpenRouter account. A workspace owner
asked to provide one shared key for the whole workspace and pay for the team's
inference centrally.

## Decision

Add an **optional** workspace-shared OpenRouter credential in a new
`canvas_workspace_ai_provider_config` table (keyed by `workspace_id`), with the
same security posture as the per-user table: encrypted with
`CANVAS_CREDENTIAL_ENCRYPTION_KEY`, RLS enabled, no `anon`/`authenticated`
policies or grants, service-role only.

Resolution at runtime is **personal-first, workspace-fallback**:

- `getOpenRouterCredential(userId, workspaceId)` returns the user's personal key
  if present, otherwise the workspace key, otherwise `null`. The returned
  `source` (`user` | `workspace`) is logged for usage attribution.
- `getOpenRouterConfigSummary(userId, workspaceId)` reports `configured: true`
  when either exists, so a member with no personal key can still pick the
  OpenRouter runtime in the deck chat. The per-turn default stays `bridge`; the
  member opts in.

Only a workspace **owner or admin** can set, rotate, or remove the shared key
(enforced in the Server Action via `getActiveWorkspace().role`; the table itself
is service-role only). The setter is recorded in `set_by` for audit.

The personal Settings → Connections section is unchanged; admins see an
additional "Workspace OpenRouter key" card.

## Consequences

- A team can adopt the OpenRouter runtime with one key; new members inherit it
  automatically (no per-user setup).
- All shared-key turns bill the single workspace key's OpenRouter account. This
  is intentional and called out in the UI.
- A member's personal key always wins, so individuals keep their own billing if
  they prefer.
- No change to the message/runtime contract, the run route's claim/settle
  logic, or the encryption envelope — this is purely an additional credential
  source behind the existing resolver.
