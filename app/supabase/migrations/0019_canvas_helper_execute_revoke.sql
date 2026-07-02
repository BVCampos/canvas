-- ============================================================
-- Security hardening: lock down SECURITY DEFINER helper EXECUTE (migration 0019)
-- ============================================================
-- ⚠️ REVERTED BY 0021 — DO NOT REINTRODUCE. The revoke below is WRONG: RLS
-- policy expressions are evaluated as the CALLING role, so `authenticated` must
-- keep EXECUTE on these helpers or every policy that calls them fails (it broke
-- workspace/deck reads in prod). Kept here only to preserve the applied history;
-- 0021 re-grants. The advisor warnings these target are accepted (non-exploitable).
-- ============================================================
-- The security advisor flags six SECURITY DEFINER helpers as REST-executable by
-- `authenticated` (via /rest/v1/rpc/...). They only ever return a boolean about
-- the CALLER'S OWN access, so they are not a cross-tenant leak — but they are an
-- unnecessary surface (and `is_co_member` is a weak co-membership oracle).
--
-- RLS policy evaluation runs these as the policy owner regardless of the
-- caller's EXECUTE privilege, so revoking EXECUTE from `authenticated` does NOT
-- affect RLS. A repo-wide check confirmed the app makes no direct `.rpc()` call
-- to any of these five. `is_workspace_admin_or_owner` IS called directly
-- (forceReleaseSlide), so it deliberately keeps its grant.
-- ============================================================

revoke execute on function public.is_workspace_member(uuid) from authenticated, anon;
revoke execute on function public.is_workspace_owner(uuid) from authenticated, anon;
revoke execute on function public.is_co_member(uuid) from authenticated, anon;
revoke execute on function public.canvas_can_read_deck(uuid) from authenticated, anon;
revoke execute on function public.canvas_can_edit_deck(uuid) from authenticated, anon;

-- KEEP: public.is_workspace_admin_or_owner(uuid) — called directly by the
-- forceReleaseSlide server action via supabase.rpc(...).
