-- ============================================================
-- REVERT migration 0019 + cover the 0020 FK (migration 0021)
-- ============================================================
-- Migration 0019 revoked EXECUTE on the RLS helper functions from
-- `authenticated`, on the theory that RLS evaluates them as the function owner.
-- That theory is WRONG: an RLS policy's USING/WITH CHECK expression is
-- evaluated as the CALLING role, so the caller must hold EXECUTE on every
-- function the policy invokes. Revoking it made every policy that calls
-- is_workspace_member / canvas_can_read_deck / canvas_can_edit_deck fail for
-- signed-in users — workspace + deck reads broke and users were bounced to
-- /no-workspace. This restores the grants.
--
-- Net effect: the six SECURITY DEFINER helpers remain EXECUTE-able by
-- `authenticated` (as they must be for RLS), and the corresponding security-
-- advisor warnings are ACCEPTED — the audit confirmed each only returns a
-- boolean about the caller's own access, so they are not a cross-tenant leak.
-- ============================================================

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;
grant execute on function public.is_co_member(uuid) to authenticated;
grant execute on function public.canvas_can_read_deck(uuid) to authenticated;
grant execute on function public.canvas_can_edit_deck(uuid) to authenticated;

-- Cover the new FK introduced by migration 0020 (clears its unindexed-FK INFO).
create index if not exists workspace_email_domain_added_by_idx
  on public.workspace_email_domain (added_by);
