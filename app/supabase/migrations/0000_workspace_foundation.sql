-- ============================================================
-- Workspace foundation (Canvas-standalone project, migration 0000)
-- ============================================================
-- Canvas used to share a Supabase project with 21x-workforce-management.
-- After the split (ADR-0004), Canvas owns its own project end-to-end.
-- This migration ports the workspace / user / membership / invite tables
-- and helper functions that previously lived in workforce-management's
-- 0001_core_tenancy.sql + 0002_core_rls.sql. The remaining canvas_*
-- migrations (0001+) reference these tables and depend on them being
-- in place first, which is why this file is 0000.
--
-- Source of truth for the workspace-tenancy DDL is workforce-management
-- (this is a verbatim port). Keep the two in sync if either side adds
-- a column — but the schemas are intentionally independent now.
-- ============================================================


-- Workspaces: the unit of tenancy.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

-- Users: app-level profile, mirrors auth.users 1:1.
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Roles (per workforce ADR-0004).
create type public.workspace_role as enum ('owner', 'admin', 'member', 'guest');

-- Memberships: who belongs to which Workspace, and as what.
create table public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  joined_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index workspace_memberships_user_id_idx on public.workspace_memberships(user_id);
create index workspace_memberships_workspace_id_idx on public.workspace_memberships(workspace_id);

-- Invites: pending invitations resolved by clicking a magic link.
create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role public.workspace_role not null default 'member',
  invited_by uuid references public.users(id) on delete set null,
  token text not null unique default replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index workspace_invites_unique_pending
  on public.workspace_invites(workspace_id, lower(email))
  where accepted_at is null;

create index workspace_invites_token_idx on public.workspace_invites(token);
create index workspace_invites_email_idx on public.workspace_invites(lower(email));


-- ============================================================
-- Triggers: mirror auth.users into public.users + maintain updated_at.
-- ============================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at_workspaces
  before update on public.workspaces
  for each row execute function public.set_updated_at();

create trigger set_updated_at_users
  before update on public.users
  for each row execute function public.set_updated_at();


-- ============================================================
-- RLS helpers. SECURITY DEFINER so they bypass RLS internally
-- (avoids infinite recursion when policies query memberships).
-- ============================================================

create or replace function public.is_workspace_member(_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = _workspace_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_owner(_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = _workspace_id and user_id = auth.uid() and role = 'owner'
  );
$$;

create or replace function public.is_workspace_admin_or_owner(_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = _workspace_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

create or replace function public.is_co_member(_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_memberships m1
    join public.workspace_memberships m2 using (workspace_id)
    where m1.user_id = auth.uid() and m2.user_id = _user_id
  );
$$;

revoke execute on function public.is_workspace_member(uuid) from public;
revoke execute on function public.is_workspace_owner(uuid) from public;
revoke execute on function public.is_workspace_admin_or_owner(uuid) from public;
revoke execute on function public.is_co_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;
grant execute on function public.is_workspace_admin_or_owner(uuid) to authenticated;
grant execute on function public.is_co_member(uuid) to authenticated;


-- ============================================================
-- RLS: enable + policies for the 4 tenancy tables.
-- ============================================================

alter table public.workspaces enable row level security;
alter table public.users enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_invites enable row level security;


-- public.workspaces

create policy "members read their workspaces"
  on public.workspaces for select
  to authenticated
  using (public.is_workspace_member(id));

create policy "admins and owners update workspace"
  on public.workspaces for update
  to authenticated
  using (public.is_workspace_admin_or_owner(id))
  with check (public.is_workspace_admin_or_owner(id));

create policy "owners delete workspace"
  on public.workspaces for delete
  to authenticated
  using (public.is_workspace_owner(id));

-- INSERT happens via service_role from the explicit "Create workspace" server
-- action on /no-workspace and (eventually) /settings/workspace. No policy
-- granted to `authenticated` so users can't create workspaces directly.


-- public.users

create policy "users read own profile"
  on public.users for select
  to authenticated
  using (id = auth.uid());

create policy "users read co-members profiles"
  on public.users for select
  to authenticated
  using (public.is_co_member(id));

create policy "users update own profile"
  on public.users for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- INSERT/DELETE: handled by the on_auth_user_created trigger + ON DELETE CASCADE from auth.users.


-- public.workspace_memberships

create policy "members read memberships in their workspaces"
  on public.workspace_memberships for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "admins insert memberships"
  on public.workspace_memberships for insert
  to authenticated
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    and (role <> 'owner' or public.is_workspace_owner(workspace_id))
  );

create policy "admins update non-owner memberships"
  on public.workspace_memberships for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    and (role <> 'owner' or public.is_workspace_owner(workspace_id))
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    and (role <> 'owner' or public.is_workspace_owner(workspace_id))
  );

create policy "admins delete non-owner memberships, owners delete any"
  on public.workspace_memberships for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    and (role <> 'owner' or public.is_workspace_owner(workspace_id))
  );


-- public.workspace_invites

create policy "admins read invites in their workspaces"
  on public.workspace_invites for select
  to authenticated
  using (public.is_workspace_admin_or_owner(workspace_id));

create policy "admins insert invites"
  on public.workspace_invites for insert
  to authenticated
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    and (role <> 'owner' or public.is_workspace_owner(workspace_id))
  );

create policy "admins delete invites"
  on public.workspace_invites for delete
  to authenticated
  using (public.is_workspace_admin_or_owner(workspace_id));

-- Invite acceptance (token lookup by an unauthenticated or non-member user)
-- uses service_role in app code; no anon-facing policy needed here.


-- ============================================================
-- Seed: 21x Ventures workspace.
-- ============================================================
-- The auto-join trigger (canvas migration 0013) routes @example.com
-- emails to this workspace id on first sign-in. The UUID is the same one
-- that was used in the workforce-shared project so the trigger doesn't
-- need any change in this split. The first @example.com user to
-- sign in gets auto-joined as 'member'; promote to 'owner' manually
-- after the fact (one-time bootstrap).
insert into public.workspaces (id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'default', 'Default Workspace')
on conflict (id) do nothing;
