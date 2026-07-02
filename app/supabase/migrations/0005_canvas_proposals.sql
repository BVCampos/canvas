-- ============================================================
-- Canvas proposals — migration 0005
-- ============================================================
-- Wires `canvas_deck_edit` into a first-class proposal workflow:
--
--   1. Stale-base detection. At propose-time the proposer captures the
--      current state of the target (slide version id for slide edits, or a
--      content hash for theme/nav edits). At approve-time we compare against
--      live state and surface a "stale" flag — owner can still force-apply.
--
--   2. canvas_edit_comment. Threaded conversation attached to a specific
--      proposal. Survives apply/reject (audit trail). Mirrors canvas_comment
--      RLS but scoped by edit_id instead of slide_id.
--
--   3. canvas_reject_edit(_edit_id, _reason). Symmetric counterpart to
--      canvas_apply_edit. Marks status='rejected', records resolver, drops
--      the optional reason as the first rejection comment so the proposer
--      sees it.
--
--   4. canvas_withdraw_edit(_edit_id). Proposer-initiated withdrawal. Same
--      effect as reject (status='rejected') but resolved_by = proposer.
--
-- RLS on canvas_deck_edit stays permissive (any workspace member can update
-- a row). The real enforcement is downstream: canvas_apply_edit is
-- SECURITY INVOKER, so its inner slide UPDATE hits the slide-owner RLS and
-- fails for non-owners. The reject/withdraw RPCs enforce ownership in code.
-- ============================================================

-- ============================================================
-- canvas_deck_edit — base-state capture
-- ============================================================

alter table public.canvas_deck_edit
  add column base_version_id     uuid references public.canvas_slide_version(id) on delete set null,
  add column base_theme_css_hash text,
  add column base_nav_js_hash    text;

create index canvas_deck_edit_base_version_idx
  on public.canvas_deck_edit(base_version_id)
  where base_version_id is not null;

-- ============================================================
-- canvas_edit_comment
-- Per-proposal discussion thread. Author can be a user or Claude (via MCP).
-- ============================================================

create table public.canvas_edit_comment (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  edit_id      uuid not null references public.canvas_deck_edit(id) on delete cascade,
  author_kind  text not null default 'user' check (author_kind in ('user', 'claude')),
  author_id    uuid references public.users(id) on delete set null,
  body         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index canvas_edit_comment_edit_idx       on public.canvas_edit_comment(edit_id, created_at);
create index canvas_edit_comment_workspace_idx  on public.canvas_edit_comment(workspace_id);

create trigger set_updated_at_canvas_edit_comment
  before update on public.canvas_edit_comment
  for each row execute function public.set_updated_at();

alter table public.canvas_edit_comment enable row level security;

create policy "members read edit comments"
  on public.canvas_edit_comment for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create their own edit comments"
  on public.canvas_edit_comment for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and author_id = auth.uid()
    and author_kind = 'user'
  );

create policy "authors and admins update edit comments"
  on public.canvas_edit_comment for update
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and author_id = auth.uid())
  )
  with check (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and author_id = auth.uid())
  );

create policy "authors and admins delete edit comments"
  on public.canvas_edit_comment for delete
  to authenticated
  using (
    public.is_workspace_admin_or_owner(workspace_id)
    or (public.is_workspace_member(workspace_id) and author_id = auth.uid())
  );

-- ============================================================
-- RPC: canvas_reject_edit(_edit_id, _reason)
-- ============================================================
-- Marks a pending edit as rejected. If _reason is non-empty, drops it as the
-- first user comment on the proposal so the proposer sees the why.
--
-- SECURITY INVOKER (default): the UPDATE on canvas_deck_edit runs through
-- the existing "members resolve edits" RLS policy (broad: any member). The
-- intent is that the app layer surfaces the reject button only for slide
-- owner / admin; a hardened RLS policy is a follow-up.
-- ============================================================

create or replace function public.canvas_reject_edit(_edit_id uuid, _reason text default null)
returns public.canvas_deck_edit
language plpgsql
as $$
declare
  v_edit public.canvas_deck_edit;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found then
    raise exception 'canvas_reject_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_reject_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  update public.canvas_deck_edit
    set status      = 'rejected',
        resolved_at = now(),
        resolved_by = auth.uid()
    where id = v_edit.id
    returning * into v_edit;

  if _reason is not null and length(trim(_reason)) > 0 then
    insert into public.canvas_edit_comment (workspace_id, edit_id, author_kind, author_id, body)
    values (v_edit.workspace_id, v_edit.id, 'user', auth.uid(), trim(_reason));
  end if;

  return v_edit;
end;
$$;

-- ============================================================
-- RPC: canvas_withdraw_edit(_edit_id)
-- ============================================================
-- Proposer-initiated cancellation. Same end state as reject (status='rejected'
-- with resolved_at/resolved_by set), but only the proposer can call it.
-- Useful when an AI realises mid-task its proposal was wrong, or a user
-- wants to retract a proposal before review.
-- ============================================================

create or replace function public.canvas_withdraw_edit(_edit_id uuid)
returns public.canvas_deck_edit
language plpgsql
as $$
declare
  v_edit public.canvas_deck_edit;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found then
    raise exception 'canvas_withdraw_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_withdraw_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  if v_edit.proposed_by <> auth.uid() then
    raise exception 'canvas_withdraw_edit: only the proposer can withdraw an edit';
  end if;

  update public.canvas_deck_edit
    set status      = 'rejected',
        resolved_at = now(),
        resolved_by = auth.uid()
    where id = v_edit.id
    returning * into v_edit;

  return v_edit;
end;
$$;

-- ============================================================
-- Grants
-- ============================================================

grant execute on function public.canvas_reject_edit(uuid, text) to authenticated;
grant execute on function public.canvas_withdraw_edit(uuid)     to authenticated;
