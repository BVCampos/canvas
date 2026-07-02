-- ============================================================
-- Canvas security follow-up — migration 0008
-- ============================================================
-- Closes the Supabase advisor warnings that 0007 surfaced. Three
-- categories of fix, all permission tightening — no behaviour change:
--
--   1. Trigger functions had EXECUTE granted to PUBLIC / anon /
--      authenticated, so they were callable via /rest/v1/rpc/...
--      Triggers fire regardless of the caller's EXECUTE permission
--      (the trigger runs as the table owner via the trigger
--      mechanism, not as the calling user), so revoking REST access
--      doesn't break any trigger.
--
--   2. The workspace_membership helpers (is_workspace_member,
--      is_workspace_admin_or_owner, is_workspace_owner, is_co_member)
--      are SECURITY DEFINER + used inside RLS policies. Authenticated
--      callers need EXECUTE for RLS evaluation; anon doesn't (anon
--      should never hit any RLS-gated table that uses these helpers,
--      since both Canvas and workforce-management are workspace-only).
--
--   3. The user-facing canvas_* RPCs (apply / reject / withdraw /
--      restore / create_snapshot) had EXECUTE granted to PUBLIC + anon
--      in addition to authenticated. They're SECURITY INVOKER so RLS
--      mediates writes, but anon should not be in their caller surface.
--
-- Bonus: SET search_path = public on every flagged function. Closes
-- the "function_search_path_mutable" advisor warnings. Existing
-- functions with this already set are unchanged.
--
-- This migration touches functions owned by the sibling
-- 21x-workforce-management app (handle_new_auth_user, log_*_activity,
-- is_workspace_* helpers, rls_auto_enable, set_updated_at). The
-- changes are pure permission tightening — they don't alter behaviour
-- and don't change function bodies. If workforce-management later
-- re-CREATEs any of these functions, the REVOKE statements will need
-- to be re-applied (CREATE OR REPLACE resets default privileges to
-- PUBLIC).
-- ============================================================

-- ============================================================
-- 1. Trigger functions — revoke all REST access
-- ============================================================
-- Triggers don't check EXECUTE on the function; they invoke it via the
-- trigger mechanism. Revoking EXECUTE just removes the /rest/v1/rpc
-- attack surface without breaking trigger firing.

revoke execute on function public.canvas_deck_edit_enforce_immutability()      from public, anon, authenticated;
revoke execute on function public.canvas_deck_slide_init_version()             from public, anon, authenticated;
revoke execute on function public.canvas_revoke_tokens_on_membership_removal() from public, anon, authenticated;
revoke execute on function public.handle_new_auth_user()                       from public, anon, authenticated;
revoke execute on function public.set_updated_at()                             from public, anon, authenticated;

-- ============================================================
-- 2. (Removed) workforce-only functions
-- ============================================================
-- The original migration revoked EXECUTE on log_client_activity /
-- log_project_activity / log_proposal_activity / log_task_activity (all
-- workforce-management trigger fns) and on rls_auto_enable (workforce
-- event trigger). After the Canvas standalone split (ADR-0004) those
-- functions don't exist in this project, so the REVOKEs are removed.

-- ============================================================
-- 3. RLS helper functions — revoke anon (keep authenticated)
-- ============================================================
-- These are invoked inside RLS policies on canvas_* and
-- workforce-management's domain tables. Authenticated users need
-- EXECUTE for the RLS policy expressions to evaluate; anon shouldn't
-- be touching any RLS-gated table that uses these helpers.

revoke execute on function public.is_co_member(uuid)                  from anon;
revoke execute on function public.is_workspace_admin_or_owner(uuid)   from anon;
revoke execute on function public.is_workspace_member(uuid)           from anon;
revoke execute on function public.is_workspace_owner(uuid)            from anon;

-- ============================================================
-- 4. User-facing canvas_* RPCs — revoke PUBLIC + anon
-- ============================================================
-- These are designed to be callable by authenticated users only. RLS
-- on the underlying tables would reject anon writes anyway, but
-- removing them from the REST surface is cleaner.

revoke execute on function public.canvas_apply_edit(uuid)                                            from public, anon;
revoke execute on function public.canvas_create_snapshot(uuid, text, text, public.canvas_snapshot_kind) from public, anon;
revoke execute on function public.canvas_reject_edit(uuid, text)                                     from public, anon;
revoke execute on function public.canvas_restore_slide_version(uuid, uuid)                           from public, anon;
revoke execute on function public.canvas_restore_snapshot(uuid)                                      from public, anon;
revoke execute on function public.canvas_withdraw_edit(uuid)                                         from public, anon;

-- ============================================================
-- 5. Pin search_path on every function that lacked it
-- ============================================================
-- Closes "function_search_path_mutable" advisor warnings. ALTER
-- FUNCTION ... SET does not touch the function body — it just records
-- the search_path config in pg_proc.proconfig. Safe and reversible.

alter function public.canvas_apply_edit(uuid)                                            set search_path = public;
alter function public.canvas_create_snapshot(uuid, text, text, public.canvas_snapshot_kind) set search_path = public;
alter function public.canvas_deck_edit_enforce_immutability()                            set search_path = public;
alter function public.canvas_deck_slide_init_version()                                   set search_path = public;
alter function public.canvas_reject_edit(uuid, text)                                     set search_path = public;
alter function public.canvas_restore_slide_version(uuid, uuid)                           set search_path = public;
alter function public.canvas_restore_snapshot(uuid)                                      set search_path = public;
alter function public.canvas_withdraw_edit(uuid)                                         set search_path = public;
alter function public.set_updated_at()                                                   set search_path = public;
