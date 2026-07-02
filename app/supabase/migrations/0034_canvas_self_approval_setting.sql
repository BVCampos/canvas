-- ============================================================
-- Canvas per-workspace self-approval setting — migration 0034
-- ============================================================
-- By default a non-admin member cannot approve (or reject) their own
-- pending proposal — the 0007 security-hardening guard requires a peer
-- reviewer, and only workspace admins/owners may self-resolve. Some teams
-- want to opt out of that ceremony and let any member approve their own
-- work. This migration adds a per-workspace opt-in flag and relaxes the
-- self-approval guard in canvas_apply_edit / canvas_reject_edit to honour
-- it.
--
-- The flag only lifts the *self-approval* guard. The underlying-table RLS
-- (canvas_deck_slide / canvas_deck "owners and admins update" policies)
-- still gates the actual write the RPC performs, so a member can only
-- self-approve edits to slides/decks they were already allowed to author
-- (owned/created/unowned slides; decks they created). No new write surface
-- is opened — this is purely about removing the "needs another reviewer"
-- requirement when the workspace has opted in.
--
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS /
-- CREATE OR REPLACE) so this migration can be re-applied safely.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The opt-in flag. Off by default — existing workspaces keep the
--    peer-review requirement untouched until an admin flips it.
-- ------------------------------------------------------------
alter table public.workspaces
  add column if not exists canvas_allow_self_approval boolean not null default false;

comment on column public.workspaces.canvas_allow_self_approval is
  'When true, any full member may approve/reject their own Canvas proposals (otherwise only workspace admins/owners may self-resolve). RLS on the target slide/deck still gates the underlying write.';

-- ------------------------------------------------------------
-- 2. SECURITY DEFINER helper mirroring is_workspace_* — reads the flag
--    while bypassing the workspaces RLS (so the proposal RPCs can consult
--    it regardless of the caller's row visibility). STABLE: pure read.
-- ------------------------------------------------------------
create or replace function public.canvas_workspace_allows_self_approval(_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select canvas_allow_self_approval
       from public.workspaces
      where id = _workspace_id),
    false
  );
$$;

revoke execute on function public.canvas_workspace_allows_self_approval(uuid) from public, anon;
grant  execute on function public.canvas_workspace_allows_self_approval(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. Relax the self-approval guard in canvas_apply_edit.
--    Re-created verbatim from the live definition (cumulative result of
--    migrations 0024/0029/0030/0032) with ONLY the guard clause changed —
--    every edit-kind branch is preserved exactly.
-- ------------------------------------------------------------
create or replace function public.canvas_apply_edit(_edit_id uuid)
returns public.canvas_slide_version
language plpgsql
set search_path = public
as $$
declare
  v_edit         public.canvas_deck_edit;
  v_slide        public.canvas_deck_slide;
  v_deck         public.canvas_deck;
  v_new_no       int;
  v_new          public.canvas_slide_version;
  v_position     int;
  v_title        text;
  v_html_body    text;
  v_slide_styles text;
  v_new_slide_id uuid;
  v_rowcount     int;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found then
    raise exception 'canvas_apply_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_apply_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  -- Self-approval guard: workspace admins/owners may always apply their own
  -- proposals. Plain members may do so only when the workspace has opted in
  -- (canvas_allow_self_approval). Everyone else still needs a peer reviewer.
  -- The underlying-table RLS gates the write below, so this only unblocks
  -- self-approving edits the proposer was already allowed to author.
  if v_edit.proposed_by = auth.uid()
     and not public.is_workspace_admin_or_owner(v_edit.workspace_id)
     and not public.canvas_workspace_allows_self_approval(v_edit.workspace_id) then
    raise exception 'canvas_apply_edit: only workspace admins can approve their own proposal';
  end if;

  if v_edit.kind in ('slide_html', 'slide_styles', 'slide_title') then
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
      case v_edit.kind when 'slide_title'  then v_edit.new_content else v_slide.title end,
      case v_edit.kind when 'slide_html'   then v_edit.new_content else v_slide.html_body end,
      case v_edit.kind when 'slide_styles' then v_edit.new_content else v_slide.slide_styles end,
      v_edit.proposed_by_kind,
      v_edit.proposed_by,
      coalesce(v_edit.rationale, v_slide.source_prompt),
      v_edit.id
    )
    returning * into v_new;

    update public.canvas_deck_slide
      set title              = v_new.title,
          html_body          = v_new.html_body,
          slide_styles       = v_new.slide_styles,
          current_version_id = v_new.id
      where id = v_slide.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: slide update touched no rows for slide %', v_slide.id;
    end if;

  elsif v_edit.kind = 'slide_edit' then
    if v_edit.slide_id is null then
      raise exception 'canvas_apply_edit: slide_id required for kind=slide_edit';
    end if;
    if v_edit.new_slide_payload is null then
      raise exception 'canvas_apply_edit: slide_edit requires new_slide_payload';
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
      coalesce(v_edit.new_slide_payload->>'title',        v_slide.title),
      coalesce(v_edit.new_slide_payload->>'html_body',    v_slide.html_body),
      coalesce(v_edit.new_slide_payload->>'slide_styles', v_slide.slide_styles),
      v_edit.proposed_by_kind,
      v_edit.proposed_by,
      coalesce(v_edit.rationale, v_slide.source_prompt),
      v_edit.id
    )
    returning * into v_new;

    update public.canvas_deck_slide
      set title              = v_new.title,
          html_body          = v_new.html_body,
          slide_styles       = v_new.slide_styles,
          current_version_id = v_new.id
      where id = v_slide.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: slide update touched no rows for slide %', v_slide.id;
    end if;

  elsif v_edit.kind = 'slide_create' then
    v_position     := (v_edit.new_slide_payload->>'position')::int;
    v_title        := coalesce(v_edit.new_slide_payload->>'title', '');
    v_html_body    := v_edit.new_slide_payload->>'html_body';
    v_slide_styles := coalesce(v_edit.new_slide_payload->>'slide_styles', '');

    if v_position < 0 then
      raise exception 'canvas_apply_edit: slide_create position must be >= 0 (got %)', v_position;
    end if;

    update public.canvas_deck_slide
       set position = position + 1
     where deck_id = v_edit.deck_id
       and position >= v_position;

    insert into public.canvas_deck_slide (
      workspace_id, deck_id, position, title, html_body, slide_styles,
      owner_id, created_by, source_prompt
    ) values (
      v_edit.workspace_id, v_edit.deck_id, v_position,
      v_title, v_html_body, v_slide_styles,
      null,
      v_edit.proposed_by,
      v_edit.rationale
    )
    returning id into v_new_slide_id;

    select * into v_new
      from public.canvas_slide_version
     where slide_id = v_new_slide_id
     order by version_no desc
     limit 1;

    if v_new.id is null then
      raise exception 'canvas_apply_edit: slide_create did not create an initial version for slide %', v_new_slide_id;
    end if;

  elsif v_edit.kind = 'slide_reorder' then
    if (select count(*) from jsonb_array_elements_text(v_edit.new_slide_payload->'order'))
       <> (select count(*) from public.canvas_deck_slide where deck_id = v_edit.deck_id) then
      raise exception 'canvas_apply_edit: slide_reorder order does not match the deck''s current slides';
    end if;

    if (select count(distinct value) from jsonb_array_elements_text(v_edit.new_slide_payload->'order') as t(value))
       <> (select count(*) from jsonb_array_elements_text(v_edit.new_slide_payload->'order')) then
      raise exception 'canvas_apply_edit: slide_reorder order contains duplicate slides';
    end if;

    if exists (
      select 1
        from jsonb_array_elements_text(v_edit.new_slide_payload->'order') as t(value)
       where not exists (
         select 1 from public.canvas_deck_slide
          where id = t.value::uuid and deck_id = v_edit.deck_id
       )
    ) then
      raise exception 'canvas_apply_edit: slide_reorder references a slide not in this deck';
    end if;

    update public.canvas_deck_slide s
       set position = (m.ord - 1)
      from (
        select value::uuid as sid, ord
          from jsonb_array_elements_text(v_edit.new_slide_payload->'order')
               with ordinality as t(value, ord)
      ) m
     where s.id = m.sid and s.deck_id = v_edit.deck_id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount <> (
      select count(*) from public.canvas_deck_slide where deck_id = v_edit.deck_id
    ) then
      raise exception 'canvas_apply_edit: slide_reorder could not rewrite all slides (insufficient privilege on some slides)';
    end if;

  elsif v_edit.kind = 'slide_delete' then
    if v_edit.slide_id is null then
      raise exception 'canvas_apply_edit: slide_id required for slide_delete';
    end if;

    select * into v_slide from public.canvas_deck_slide where id = v_edit.slide_id;
    if not found then
      raise exception 'canvas_apply_edit: slide % not found (already deleted?)', v_edit.slide_id;
    end if;

    if (select count(*) from public.canvas_deck_slide where deck_id = v_edit.deck_id) <= 1 then
      raise exception 'canvas_apply_edit: cannot delete the deck''s only slide';
    end if;

    delete from public.canvas_deck_slide where id = v_slide.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: slide_delete removed no rows - you may not have permission to delete this slide, or it was already deleted';
    end if;

    update public.canvas_deck_slide
       set position = position - 1
     where deck_id = v_edit.deck_id
       and position > v_slide.position;

  elsif v_edit.kind = 'theme_css' then
    select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
    if not found then
      raise exception 'canvas_apply_edit: deck % not found', v_edit.deck_id;
    end if;

    update public.canvas_deck
      set theme_css = v_edit.new_content
      where id = v_deck.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: theme update touched no rows for deck %', v_deck.id;
    end if;

  elsif v_edit.kind = 'nav_js' then
    select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
    if not found then
      raise exception 'canvas_apply_edit: deck % not found', v_edit.deck_id;
    end if;

    update public.canvas_deck
      set nav_js = v_edit.new_content
      where id = v_deck.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: nav update touched no rows for deck %', v_deck.id;
    end if;

  elsif v_edit.kind = 'deck_title' then
    select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
    if not found then
      raise exception 'canvas_apply_edit: deck % not found', v_edit.deck_id;
    end if;
    if length(trim(v_edit.new_content)) = 0 then
      raise exception 'canvas_apply_edit: deck_title cannot be empty';
    end if;
    update public.canvas_deck
      set title = v_edit.new_content
      where id = v_deck.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: title update touched no rows for deck %', v_deck.id;
    end if;
  else
    raise exception 'canvas_apply_edit: unsupported edit kind %', v_edit.kind;
  end if;

  if v_edit.kind <> 'slide_delete' then
    update public.canvas_deck_edit
      set status      = 'applied',
          resolved_at = now(),
          resolved_by = auth.uid()
      where id = v_edit.id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: could not mark edit % applied', v_edit.id;
    end if;
  end if;

  return v_new;
end;
$$;

-- ------------------------------------------------------------
-- 4. Relax the self-approval guard in canvas_reject_edit (mirrors apply).
-- ------------------------------------------------------------
create or replace function public.canvas_reject_edit(_edit_id uuid, _reason text default null)
returns public.canvas_deck_edit
language plpgsql
set search_path = public
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

  -- Mirror canvas_apply_edit: non-admin proposers may self-reject only when
  -- the workspace has opted in (canvas_allow_self_approval). Otherwise they
  -- should use canvas_withdraw_edit, which keeps the proposer-initiated audit
  -- trail clean. Admins/owners can reject anything.
  if v_edit.proposed_by = auth.uid()
     and not public.is_workspace_admin_or_owner(v_edit.workspace_id)
     and not public.canvas_workspace_allows_self_approval(v_edit.workspace_id) then
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

-- CREATE OR REPLACE preserves existing grants, but re-issue them so the
-- migration is self-contained and matches the 0007 pattern.
grant execute on function public.canvas_apply_edit(uuid)        to authenticated;
grant execute on function public.canvas_reject_edit(uuid, text) to authenticated;
