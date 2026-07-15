-- ============================================================
-- Hosted BYOK providers — migration 0076 (ADR-0014)
-- ============================================================
-- The hosted assistant runtime now accepts a personal Anthropic or OpenAI API
-- key alongside the original OpenRouter path. The stored credential rows gain
-- nothing new — the existing `provider` column simply stops being pinned to
-- 'openrouter'.
--
-- Deliberately NOT touched: canvas_user_ai_provider_config.default_runtime and
-- canvas_assistant_message.execution_runtime keep their 'openrouter' value and
-- CHECKs. That stored id now MEANS "hosted API runtime" generically — the
-- discriminator separates the local bridge from the server-side runner, not
-- one API vendor from another. Renaming it would be a data migration across
-- every historical assistant message for zero user-visible benefit (naming
-- debt recorded in ADR-0014).
-- ============================================================

alter table public.canvas_user_ai_provider_config
  drop constraint if exists canvas_user_ai_provider_config_provider_check;
alter table public.canvas_user_ai_provider_config
  add constraint canvas_user_ai_provider_config_provider_check
  check (provider in ('openrouter', 'anthropic', 'openai'));

comment on column public.canvas_user_ai_provider_config.provider is
  'Which API vendor the encrypted key belongs to. One credential per user; switching provider replaces it.';

alter table public.canvas_workspace_ai_provider_config
  drop constraint if exists canvas_workspace_ai_provider_config_provider_check;
alter table public.canvas_workspace_ai_provider_config
  add constraint canvas_workspace_ai_provider_config_provider_check
  check (provider in ('openrouter', 'anthropic', 'openai'));

comment on column public.canvas_workspace_ai_provider_config.provider is
  'Which API vendor the workspace-shared encrypted key belongs to.';
