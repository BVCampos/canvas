-- ============================================================
-- Bridge version on presence — migration 0051
-- ============================================================
-- The local canvas-agent bridge POSTs presence on every poll but never reports
-- its own version, so the server can't tell an OUTDATED bridge from a current
-- one. A new MCP tool that an old bridge doesn't auto-approve silently fails the
-- turn with no "your bridge is N versions behind" signal. Record the version the
-- bridge sends (x-bridge-version header) so the chatbox can surface it and nudge
-- an update.
--
-- Additive + nullable: existing presence rows + an older bridge that sends no
-- version stay NULL (rendered as "unknown version" in the UI). No behavior
-- change to the poll path itself.
-- ============================================================

alter table public.canvas_assistant_bridge_presence
  add column if not exists bridge_version text;

comment on column public.canvas_assistant_bridge_presence.bridge_version is
  'Version the canvas-agent bridge reported on its last poll (x-bridge-version '
  'header). NULL = an older bridge that does not send it. See migration 0051.';
