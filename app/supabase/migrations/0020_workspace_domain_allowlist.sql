-- ============================================================
-- Security: domain auto-join allow-list table (migration 0020)
-- ============================================================
-- Migration 0013 hardcoded the auto-join rule (`@example.com` → the 21x
-- workspace). That is safe today, but it is a tenancy foot-gun: the moment a
-- second domain/workspace is added, an unverified or public domain could
-- silently auto-join strangers. This promotes the rule to an explicit,
-- admin-curated allow-list table (the path 0013's own comment anticipated) and
-- rewrites the trigger to read from it. Behavior is unchanged for the existing
-- seeded rule — @example.com still auto-joins the same workspace as
-- 'member'. Adding a row is now a deliberate, attributable action; never add a
-- domain a workspace doesn't provably control.
-- ============================================================

create table if not exists public.workspace_email_domain (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  domain text not null,
  default_role public.workspace_role not null default 'member',
  added_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  primary key (workspace_id, domain)
);

alter table public.workspace_email_domain enable row level security;

-- Read-only to workspace admins/owners; writes are service-role only (no
-- INSERT/UPDATE/DELETE policy for authenticated), so a member cannot map a new
-- domain to their workspace through the API.
drop policy if exists "workspace admins read email domains" on public.workspace_email_domain;
create policy "workspace admins read email domains" on public.workspace_email_domain
  for select to authenticated
  using (is_workspace_admin_or_owner(workspace_id));

-- Seed the existing hardcoded rule (idempotent).
insert into public.workspace_email_domain (workspace_id, domain)
values ('00000000-0000-0000-0000-000000000001', 'example.com')
on conflict do nothing;

-- Rewrite the trigger function to read the allow-list. Same name/signature, so
-- the existing trigger and the 0013 EXECUTE revokes still apply.
create or replace function public.handle_new_user_workspace_auto_join()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text := lower(split_part(coalesce(new.email, ''), '@', 2));
begin
  if v_domain = '' then
    return new;
  end if;

  insert into public.workspace_memberships (workspace_id, user_id, role)
  select d.workspace_id, new.id, d.default_role
    from public.workspace_email_domain d
   where d.domain = v_domain
  on conflict (workspace_id, user_id) do nothing;

  return new;
end;
$$;
