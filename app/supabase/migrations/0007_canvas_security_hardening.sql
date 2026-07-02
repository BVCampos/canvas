-- ============================================================
-- Canvas security hardening — migration 0007
-- ============================================================
-- Closes three gaps surfaced by the pre-launch security audit:
--
--   1. canvas_deck_edit was effectively mutable post-insert. The
--      "members resolve edits" UPDATE policy let any workspace member
--      change ANY column on a pending proposal — including new_content,
--      kind, proposed_by — which means a peer could swap a proposer's
--      HTML between propose and approve without the diff changing in the
--      reviewer's UI. We lock the row down with a BEFORE UPDATE trigger
--      that enforces column-level immutability; only the resolution
--      fields (status, resolved_at, resolved_by) may move.
--
--   2. canvas_apply_edit had no DB-level self-approval guard. The "you
--      can't approve your own proposal" rule lived only in the app layer
--      (proposal-queries.ts isProposer check), so any caller hitting the
--      RPC directly could approve their own row. Workspace admins and
--      owners legitimately need to self-approve (e.g. for proposals they
--      author via Claude); everyone else does not. We bake that rule
--      into the RPC and into canvas_reject_edit.
--
--   3. canvas_mcp_token survived workspace-membership removal. The token
--      row references workspaces(id) ON DELETE CASCADE, but not the
--      membership row — so revoking someone's access to the workspace
--      did not revoke their personal MCP tokens scoped to it. We add an
--      AFTER DELETE trigger on workspace_memberships that nukes any
--      matching token rows.
--
-- All statements are idempotent (DROP IF EXISTS / CREATE OR REPLACE) so
-- this migration can be re-applied safely.
-- ============================================================

-- ============================================================
-- Change 1 — Lock down canvas_deck_edit mutations
-- ============================================================
-- Strategy: keep the existing RLS USING clause (any workspace member can
-- target the row, which the resolve UI needs), but replace the WITH CHECK
-- with the same membership predicate and enforce per-column immutability
-- via a BEFORE UPDATE trigger. RLS WITH CHECK in Postgres cannot reference
-- OLD, so a trigger is the cleanest idiom for "these columns may not
-- change after insert".
--
-- Immutable post-insert:
--   workspace_id, deck_id, slide_id, kind, proposed_by, proposed_by_kind,
--   new_content, rationale, created_at, base_version_id,
--   base_theme_css_hash, base_nav_js_hash
--
-- Mutable (resolution fields only):
--   status, resolved_at, resolved_by

drop policy if exists "members resolve edits" on public.canvas_deck_edit;

create policy "members resolve edits"
  on public.canvas_deck_edit for update
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create or replace function public.canvas_deck_edit_enforce_immutability()
returns trigger
language plpgsql
as $$
begin
  if new.workspace_id        is distinct from old.workspace_id        then raise exception 'canvas_deck_edit.workspace_id is immutable';        end if;
  if new.deck_id             is distinct from old.deck_id             then raise exception 'canvas_deck_edit.deck_id is immutable';             end if;
  if new.slide_id            is distinct from old.slide_id            then raise exception 'canvas_deck_edit.slide_id is immutable';            end if;
  if new.kind                is distinct from old.kind                then raise exception 'canvas_deck_edit.kind is immutable';                end if;
  if new.proposed_by         is distinct from old.proposed_by         then raise exception 'canvas_deck_edit.proposed_by is immutable';         end if;
  if new.proposed_by_kind    is distinct from old.proposed_by_kind    then raise exception 'canvas_deck_edit.proposed_by_kind is immutable';    end if;
  if new.new_content         is distinct from old.new_content         then raise exception 'canvas_deck_edit.new_content is immutable';         end if;
  if new.rationale           is distinct from old.rationale           then raise exception 'canvas_deck_edit.rationale is immutable';           end if;
  if new.created_at          is distinct from old.created_at          then raise exception 'canvas_deck_edit.created_at is immutable';          end if;
  if new.base_version_id     is distinct from old.base_version_id     then raise exception 'canvas_deck_edit.base_version_id is immutable';     end if;
  if new.base_theme_css_hash is distinct from old.base_theme_css_hash then raise exception 'canvas_deck_edit.base_theme_css_hash is immutable'; end if;
  if new.base_nav_js_hash    is distinct from old.base_nav_js_hash    then raise exception 'canvas_deck_edit.base_nav_js_hash is immutable';    end if;
  return new;
end;
$$;

drop trigger if exists canvas_deck_edit_enforce_immutability_trg on public.canvas_deck_edit;
create trigger canvas_deck_edit_enforce_immutability_trg
  before update on public.canvas_deck_edit
  for each row execute function public.canvas_deck_edit_enforce_immutability();

-- ============================================================
-- Change 2 — Allow admin/owner self-approve; block everyone else
-- ============================================================
-- The "you can't approve your own proposal" rule currently lives only in
-- the proposal-queries.ts isProposer check. We push it down to the RPC so
-- a direct RPC caller (e.g. someone hitting the REST endpoint) is also
-- bound by it. Admins and owners are exempt because they legitimately
-- need to apply their own proposals (typical when authoring via Claude
-- and reviewing through the right-rail with no peer available).
--
-- canvas_reject_edit gets the same treatment so a non-admin proposer
-- cannot bypass canvas_withdraw_edit's audit trail by self-rejecting
-- through canvas_reject_edit (the resolution-status semantics differ).

create or replace function public.canvas_apply_edit(_edit_id uuid)
returns public.canvas_slide_version
language plpgsql
as $$
declare
  v_edit       public.canvas_deck_edit;
  v_slide      public.canvas_deck_slide;
  v_deck       public.canvas_deck;
  v_new_no     int;
  v_new        public.canvas_slide_version;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found then
    raise exception 'canvas_apply_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_apply_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  -- Self-approval guard: only workspace admins/owners may apply their own
  -- proposals. Everyone else must have a different reviewer.
  if v_edit.proposed_by = auth.uid()
     and not public.is_workspace_admin_or_owner(v_edit.workspace_id) then
    raise exception 'canvas_apply_edit: only workspace admins can approve their own proposal';
  end if;

  if v_edit.kind in ('slide_html', 'slide_styles') then
    if v_edit.slide_id is null then
      raise exception 'canvas_apply_edit: slide_id required for kind=%', v_edit.kind;
    end if;

    select * into v_slide from public.canvas_deck_slide where id = v_edit.slide_id;
    if not found then
      raise exception 'canvas_apply_edit: slide % not found', v_edit.slide_id;
    end if;

    select coalesce(max(version_no), 0) + 1
      into v_new_no
      from public.canvas_slide_version
     where slide_id = v_slide.id;

    insert into public.canvas_slide_version (
      workspace_id, deck_id, slide_id, version_no, parent_version_id,
      title, html_body, slide_styles,
      author_kind, created_by, source_prompt, source_edit_id
    )
    values (
      v_slide.workspace_id, v_slide.deck_id, v_slide.id, v_new_no, v_slide.current_version_id,
      v_slide.title,
      case v_edit.kind when 'slide_html'   then v_edit.new_content else v_slide.html_body end,
      case v_edit.kind when 'slide_styles' then v_edit.new_content else v_slide.slide_styles end,
      v_edit.proposed_by_kind,
      v_edit.proposed_by,
      coalesce(v_edit.rationale, v_slide.source_prompt),
      v_edit.id
    )
    returning * into v_new;

    update public.canvas_deck_slide
      set html_body          = v_new.html_body,
          slide_styles       = v_new.slide_styles,
          current_version_id = v_new.id
      where id = v_slide.id;

  elsif v_edit.kind = 'theme_css' then
    select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
    if not found then
      raise exception 'canvas_apply_edit: deck % not found', v_edit.deck_id;
    end if;

    update public.canvas_deck
      set theme_css = v_edit.new_content
      where id = v_deck.id;

  elsif v_edit.kind = 'nav_js' then
    select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
    if not found then
      raise exception 'canvas_apply_edit: deck % not found', v_edit.deck_id;
    end if;

    update public.canvas_deck
      set nav_js = v_edit.new_content
      where id = v_deck.id;
  else
    raise exception 'canvas_apply_edit: unsupported edit kind %', v_edit.kind;
  end if;

  update public.canvas_deck_edit
    set status      = 'applied',
        resolved_at = now(),
        resolved_by = auth.uid()
    where id = v_edit.id;

  return v_new;
end;
$$;

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

  -- Mirror canvas_apply_edit: non-admin proposers cannot self-reject through
  -- this RPC (they should call canvas_withdraw_edit instead, which keeps the
  -- proposer-initiated audit trail clean). Admins/owners can reject anything.
  if v_edit.proposed_by = auth.uid()
     and not public.is_workspace_admin_or_owner(v_edit.workspace_id) then
    raise exception 'canvas_reject_edit: only workspace admins can reject their own proposal (use canvas_withdraw_edit instead)';
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

grant execute on function public.canvas_apply_edit(uuid)               to authenticated;
grant execute on function public.canvas_reject_edit(uuid, text)        to authenticated;

-- ============================================================
-- Change 3 — Revoke MCP tokens on membership removal
-- ============================================================
-- canvas_mcp_token has FKs to workspaces(id) ON DELETE CASCADE and to
-- users(id) ON DELETE CASCADE, so deleting the workspace or the user kills
-- the token. But revoking just the membership (the common case when an
-- employee leaves a workspace but stays on the platform) left the token
-- behind: the MCP route resolves token -> user via the service-role client
-- and would happily keep serving that user's now-revoked workspace.
--
-- A SECURITY DEFINER trigger on workspace_memberships catches the delete
-- and removes any matching tokens. It uses search_path=public so the table
-- reference resolves even if the caller's search_path is exotic.

create or replace function public.canvas_revoke_tokens_on_membership_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.canvas_mcp_token
   where user_id      = old.user_id
     and workspace_id = old.workspace_id;
  return old;
end;
$$;

drop trigger if exists canvas_revoke_tokens_on_membership_removal_trg on public.workspace_memberships;
create trigger canvas_revoke_tokens_on_membership_removal_trg
  after delete on public.workspace_memberships
  for each row
  execute function public.canvas_revoke_tokens_on_membership_removal();
