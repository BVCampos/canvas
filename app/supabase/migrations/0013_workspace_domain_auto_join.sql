-- ============================================================
-- Workspace domain auto-join (migration 0013)
-- ============================================================
-- When a new auth.users row is created (any sign-in path: Google OAuth,
-- magic link, invite), check whether the email belongs to a trusted
-- domain and, if so, auto-provision a workspace membership.
--
-- v0 hardcodes a single rule: @example.com → 21x Ventures workspace
-- (id 00000000-0000-0000-0000-000000000001) as 'member'. We chose a
-- hardcoded rule over a config table because (a) there's exactly one
-- internal domain today, (b) routing it through a config table would
-- require RLS on the config and a service-role read inside the trigger,
-- and (c) when we add a second domain we can promote this to a table.
--
-- INSERT-only trigger (not UPDATE): we only auto-join on first sign-in.
-- If an admin later removes the membership, re-signing in won't silently
-- restore access — a re-invite is required. This matches the "deliberate
-- decision per person" property we wanted to preserve for non-domain users.
--
-- Trigger runs with SECURITY DEFINER (owned by postgres) so it can write
-- workspace_memberships under RLS. The function is intentionally narrow:
-- one INSERT, ON CONFLICT DO NOTHING, no other side effects.
-- ============================================================

create or replace function public.handle_new_user_workspace_auto_join()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(new.email, ''));
begin
  -- @example.com → 21x Ventures workspace as 'member'.
  if v_email like '%@example.com' then
    insert into public.workspace_memberships (workspace_id, user_id, role)
    values (
      '00000000-0000-0000-0000-000000000001',
      new.id,
      'member'
    )
    on conflict (workspace_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

-- Drop-and-recreate is safe: we own this trigger end-to-end.
drop trigger if exists on_auth_user_created_workspace_auto_join on auth.users;

create trigger on_auth_user_created_workspace_auto_join
  after insert on auth.users
  for each row
  execute function public.handle_new_user_workspace_auto_join();

-- Lock down the function: only the postgres role (which owns it) and the
-- trigger context should be able to execute. authenticated/anon must not
-- be able to call it directly.
revoke all on function public.handle_new_user_workspace_auto_join() from public;
revoke all on function public.handle_new_user_workspace_auto_join() from authenticated;
revoke all on function public.handle_new_user_workspace_auto_join() from anon;
