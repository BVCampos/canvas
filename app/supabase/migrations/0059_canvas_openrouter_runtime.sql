-- ============================================================
-- Canvas assistant — OpenRouter runtime + encrypted credentials
-- ============================================================
-- The in-deck chat can now execute in one of two places:
--   • bridge     — the existing local canvas-agent process
--   • openrouter — Canvas's server calls OpenRouter with the user's own key
--
-- The discriminator is stamped on every message so the bridge and the server
-- runner can never claim or settle one another's work. Existing rows remain
-- local-bridge turns through the default/backfill.
--
-- OpenRouter keys are encrypted by the application before INSERT. The table is
-- deliberately service-role only: authenticated users do not receive even the
-- ciphertext through PostgREST. Server actions return only key_hint + settings.
-- ============================================================

alter table public.canvas_assistant_message
  add column if not exists execution_runtime text not null default 'bridge',
  add column if not exists provider_model text,
  add column if not exists provider_usage jsonb;

alter table public.canvas_assistant_message
  drop constraint if exists canvas_assistant_message_execution_runtime_check;
alter table public.canvas_assistant_message
  add constraint canvas_assistant_message_execution_runtime_check
  check (execution_runtime in ('bridge', 'openrouter'));

comment on column public.canvas_assistant_message.execution_runtime is
  'Worker allowed to claim this turn: local bridge or server-side OpenRouter.';
comment on column public.canvas_assistant_message.provider_model is
  'Actual provider model reported for an API-backed assistant response.';
comment on column public.canvas_assistant_message.provider_usage is
  'Provider-reported token/cost usage for an API-backed assistant response.';

-- Replace the bridge-era partial index with one that can isolate each runtime.
drop index if exists public.canvas_assistant_message_queued_idx;
create index if not exists canvas_assistant_message_queued_idx
  on public.canvas_assistant_message
    (workspace_id, user_id, execution_runtime, created_at)
  where role = 'user' and status = 'queued';

create table if not exists public.canvas_user_ai_provider_config (
  user_id uuid primary key references public.users(id) on delete cascade,
  provider text not null default 'openrouter'
    check (provider = 'openrouter'),
  encrypted_api_key text not null,
  key_hint text not null,
  model_id text not null default 'openrouter/auto',
  default_runtime text not null default 'bridge'
    check (default_runtime in ('bridge', 'openrouter')),
  validated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canvas_user_ai_provider_config is
  'Service-only encrypted personal AI provider credentials and chat defaults. Never expose encrypted_api_key to browser clients.';
comment on column public.canvas_user_ai_provider_config.encrypted_api_key is
  'AES-256-GCM envelope produced by the server with CANVAS_CREDENTIAL_ENCRYPTION_KEY.';
comment on column public.canvas_user_ai_provider_config.key_hint is
  'Non-secret masked suffix shown in Connections, e.g. ••••a1b2.';

create or replace function public.canvas_user_ai_provider_config_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.canvas_user_ai_provider_config_touch()
  from public, anon, authenticated;

drop trigger if exists canvas_user_ai_provider_config_touch_trg
  on public.canvas_user_ai_provider_config;
create trigger canvas_user_ai_provider_config_touch_trg
  before update on public.canvas_user_ai_provider_config
  for each row execute function public.canvas_user_ai_provider_config_touch();

alter table public.canvas_user_ai_provider_config enable row level security;

-- Intentionally no authenticated policies. The service-role data layer first
-- authenticates the request, then re-scopes every read/write to auth user_id.
revoke all on table public.canvas_user_ai_provider_config from public, anon, authenticated;
grant all on table public.canvas_user_ai_provider_config to service_role;

