-- ============================================================
-- MCP token expiry — migration 0049
-- ============================================================
-- MCP tokens were valid forever once minted. Add an optional expiry so a new
-- token has a bounded lifetime (the app sets ~180 days at mint), and a leaked
-- or forgotten token eventually stops working on its own.
--
-- Additive + back-compatible: the column is nullable and existing rows stay
-- NULL, which the lookup paths (api/mcp/[token], the assistant bridge) treat as
-- "never expires" — so no existing token breaks. Only tokens minted after this
-- ships carry an expiry.
--
-- This is the SAFE half of the token-hardening item. Hashing the token at rest
-- needs a destructive change to the token primary key and is deferred (see
-- docs/discovery/improvement-map-execution.md).
-- ============================================================

alter table public.canvas_mcp_token
  add column if not exists expires_at timestamptz;

comment on column public.canvas_mcp_token.expires_at is
  'Optional expiry. NULL = never expires (legacy tokens). New tokens get ~180d; '
  'lookups in api/mcp/[token] + the assistant bridge reject an expired token.';
