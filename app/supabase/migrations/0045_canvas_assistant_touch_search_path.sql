-- ============================================================
-- Canvas assistant — pin search_path on the touch triggers  (migration 0045)
-- ============================================================
-- The two updated_at touch trigger functions ship with a MUTABLE search_path
-- (Supabase advisor: function_search_path_mutable WARN). Their sibling
-- canvas_assistant_thread_bump already pins `set search_path = public`; these
-- two never did. Both are simple updated_at setters that reference no schema-
-- qualified objects, so pinning the path is purely hardening — no behaviour
-- change — and silences the advisor.
--
--   • public.canvas_assistant_message_touch()  — defined in 0041
--   • public.canvas_assistant_thread_touch()   — defined in 0042
-- ============================================================

alter function public.canvas_assistant_message_touch() set search_path = public;
alter function public.canvas_assistant_thread_touch()  set search_path = public;
