-- ============================================================
-- Workspace-shared OpenRouter credentials — migration 0060
-- ============================================================
-- Extends ADR-0010's per-user OpenRouter config with an OPTIONAL workspace-level
-- shared key. Runtime resolution is personal-first, workspace-fallback: a member
-- with no personal key transparently uses the workspace key. Same posture as
-- canvas_user_ai_provider_config — encrypted by the app, service-role only, so
-- authenticated browser clients never receive even the ciphertext via PostgREST.
-- ============================================================

create table if not exists public.canvas_workspace_ai_provider_config (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  provider text not null default 'openrouter'
    check (provider = 'openrouter'),
  encrypted_api_key text not null,
  key_hint text not null,
  model_id text not null default 'openrouter/auto',
  set_by uuid references public.users(id) on delete set null,
  validated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canvas_workspace_ai_provider_config is
  'Service-only encrypted workspace-shared OpenRouter credential. Resolved as a fallback when a member has no personal config. Never expose encrypted_api_key to browser clients.';
comment on column public.canvas_workspace_ai_provider_config.set_by is
  'Owner/admin who last set this workspace key (audit only; nulled if that user is deleted).';

create or replace function public.canvas_workspace_ai_provider_config_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.canvas_workspace_ai_provider_config_touch()
  from public, anon, authenticated;

drop trigger if exists canvas_workspace_ai_provider_config_touch_trg
  on public.canvas_workspace_ai_provider_config;
create trigger canvas_workspace_ai_provider_config_touch_trg
  before update on public.canvas_workspace_ai_provider_config
  for each row execute function public.canvas_workspace_ai_provider_config_touch();

alter table public.canvas_workspace_ai_provider_config enable row level security;

-- Intentionally no authenticated policies. The service-role data layer
-- authenticates the request, verifies the actor is an owner/admin of the
-- workspace before any write, and re-scopes every read to the workspace.
revoke all on table public.canvas_workspace_ai_provider_config from public, anon, authenticated;
grant all on table public.canvas_workspace_ai_provider_config to service_role;
