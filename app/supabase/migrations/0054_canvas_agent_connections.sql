-- ============================================================
-- Agent-agnostic connection metadata — migration 0054
-- ============================================================
-- Canvas accepts any MCP-compatible agent. Keep the bearer token as the
-- identity boundary, while recording the last client that initialized with
-- it so the UI can report truthful, provider-neutral connection state.
-- The local assistant bridge reports its selected adapter separately.

alter table public.canvas_mcp_token
  add column if not exists last_client_name text,
  add column if not exists last_client_version text;

comment on column public.canvas_mcp_token.last_client_name is
  'MCP initialize.clientInfo.name from the most recent successful client initialization.';
comment on column public.canvas_mcp_token.last_client_version is
  'MCP initialize.clientInfo.version from the most recent successful client initialization.';

alter table public.canvas_assistant_bridge_presence
  add column if not exists agent_provider text;

comment on column public.canvas_assistant_bridge_presence.agent_provider is
  'Local bridge adapter currently polling for this user (for example claude or codex).';
