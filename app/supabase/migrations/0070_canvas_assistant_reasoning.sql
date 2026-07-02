-- ============================================================
-- Assistant reasoning stream
-- ============================================================
-- Reasoning models (the default glm-5.2 config included) emit their thinking
-- as delta.reasoning BEFORE any visible content. The runner used to drop it,
-- so the panel showed a dead spinner for the whole reasoning phase — prod
-- logged users canceling after 3m40s+ of silence (assistant speed discovery
-- 2026-07 #1). The runner now streams it here alongside content; the panel
-- renders it as a collapsible "Thinking" block. The table already rides the
-- supabase_realtime publication, so the column streams with no other change.

alter table public.canvas_assistant_message
  add column if not exists reasoning text;

comment on column public.canvas_assistant_message.reasoning is
  'Model reasoning stream for this assistant turn (visible thinking). Flushed incrementally by the runner; null for user rows and non-reasoning models.';
