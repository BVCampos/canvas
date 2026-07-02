-- ============================================================
-- Canvas edit-pending-proposals — migration 0035
-- ============================================================
-- Until now a pending proposal (canvas_deck_edit) was frozen between propose
-- and resolve: the 0007/0010/0012 immutability trigger locks new_content,
-- new_slide_payload, rationale and every base_* field so the diff a reviewer
-- reads cannot be mutated under them. The only way to change a proposal was
-- withdraw -> re-propose, which loses the comment thread and the proposal id.
--
-- This migration lets the proposer (and any approver) EDIT a pending proposal
-- in place, without reopening the hole the trigger guards against. Three moves:
--
--   1. Audit + optimistic-concurrency columns (revision / last_edited_*).
--   2. The immutability trigger now bypasses its content checks ONLY when a
--      transaction-local GUC (canvas.allow_edit_content) is set — and the
--      GUC is set in exactly one place: the canvas_update_edit RPC, right
--      around its UPDATE. Every other UPDATE path (the broad "members resolve
--      edits" RLS policy, a raw REST PATCH, the apply/reject/withdraw RPCs)
--      still hits the frozen-content guard. So content can only change through
--      the one audited, permission-checked function.
--   3. canvas_update_edit(...) — SECURITY INVOKER, re-checks proposer-or-
--      approver, re-bases the diff to current target state, bumps revision,
--      and drops an audit comment. canvas_apply_edit gains an optional
--      _expected_revision so a reviewer can't approve content that was edited
--      out from under them after they opened it.
--
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS) so the migration can be re-applied safely.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Audit + optimistic-concurrency columns.
--    revision starts at 0 and increments on every edit. last_edited_* record
--    who last revised the proposal and when (distinct from proposed_by, which
--    stays the original author even when an approver edits the proposal).
--    These columns are intentionally NOT added to the immutability trigger's
--    locked set, so canvas_update_edit can bump them.
-- ------------------------------------------------------------
alter table public.canvas_deck_edit
  add column if not exists revision       int not null default 0,
  add column if not exists last_edited_at timestamptz,
  add column if not exists last_edited_by uuid references public.users(id) on delete set null;

comment on column public.canvas_deck_edit.revision is
  'Monotonic edit counter (0 at propose time). Bumped by canvas_update_edit; passed as canvas_apply_edit._expected_revision for optimistic concurrency on approve.';

-- ------------------------------------------------------------
-- 2. Gate the immutability trigger on a transaction-local flag.
--    Re-created verbatim from the 0012 definition with ONLY the GUC short-
--    circuit prepended. With the flag unset (every normal UPDATE) the
--    per-column freeze runs exactly as before.
-- ------------------------------------------------------------
create or replace function public.canvas_deck_edit_enforce_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- canvas_update_edit sets this GUC transaction-locally around its own UPDATE
  -- to authorize a content revision. current_setting(..., true) returns NULL
  -- (not an error) when the GUC was never set, so the comparison is false on
  -- every other UPDATE path and the immutability checks below still run.
  if current_setting('canvas.allow_edit_content', true) = '1' then
    return new;
  end if;

  if new.workspace_id        is distinct from old.workspace_id        then raise exception 'canvas_deck_edit.workspace_id is immutable';        end if;
  if new.deck_id             is distinct from old.deck_id             then raise exception 'canvas_deck_edit.deck_id is immutable';             end if;
  if new.slide_id            is distinct from old.slide_id            then raise exception 'canvas_deck_edit.slide_id is immutable';            end if;
  if new.kind                is distinct from old.kind                then raise exception 'canvas_deck_edit.kind is immutable';                end if;
  if new.proposed_by         is distinct from old.proposed_by         then raise exception 'canvas_deck_edit.proposed_by is immutable';         end if;
  if new.proposed_by_kind    is distinct from old.proposed_by_kind    then raise exception 'canvas_deck_edit.proposed_by_kind is immutable';    end if;
  if new.new_content         is distinct from old.new_content         then raise exception 'canvas_deck_edit.new_content is immutable';         end if;
  if new.new_slide_payload   is distinct from old.new_slide_payload   then raise exception 'canvas_deck_edit.new_slide_payload is immutable';   end if;
  if new.rationale           is distinct from old.rationale           then raise exception 'canvas_deck_edit.rationale is immutable';           end if;
  if new.created_at          is distinct from old.created_at          then raise exception 'canvas_deck_edit.created_at is immutable';          end if;
  if new.base_version_id     is distinct from old.base_version_id     then raise exception 'canvas_deck_edit.base_version_id is immutable';     end if;
  if new.base_theme_css_hash is distinct from old.base_theme_css_hash then raise exception 'canvas_deck_edit.base_theme_css_hash is immutable'; end if;
  if new.base_nav_js_hash    is distinct from old.base_nav_js_hash    then raise exception 'canvas_deck_edit.base_nav_js_hash is immutable';    end if;
  if new.base_deck_title     is distinct from old.base_deck_title     then raise exception 'canvas_deck_edit.base_deck_title is immutable';     end if;
  return new;
end;
$$;

revoke execute on function public.canvas_deck_edit_enforce_immutability() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. canvas_update_edit — revise a pending proposal in place.
--    SECURITY INVOKER: the UPDATE rides the user's RLS, and we additionally
--    enforce proposer-OR-approver in the body (RLS alone is too broad — the
--    "members resolve edits" policy lets any member UPDATE the row). The
--    per-kind shape is re-validated here AND backstopped by the
--    canvas_deck_edit_content_shape_chk CHECK constraint.
-- ------------------------------------------------------------
create or replace function public.canvas_update_edit(
  _edit_id           uuid,
  _new_content       text  default null,
  _new_slide_payload jsonb default null,
  _rationale         text  default null,
  _expected_revision int   default null
)
returns public.canvas_deck_edit
language plpgsql
set search_path = public
as $$
declare
  v_edit            public.canvas_deck_edit;
  v_is_proposer     boolean;
  v_is_admin        boolean;
  v_has_target      boolean := false;
  v_base_version_id uuid;
  v_base_theme_hash text;
  v_base_nav_hash   text;
  v_base_deck_title text;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found then
    raise exception 'canvas_update_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_update_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  -- Optimistic concurrency: refuse to clobber an edit that moved on since the
  -- caller loaded it (e.g. the proposer and an approver editing at once).
  if _expected_revision is not null and v_edit.revision <> _expected_revision then
    raise exception 'canvas_update_edit: proposal_changed_since_load (expected revision %, current %)',
      _expected_revision, v_edit.revision;
  end if;

  -- Permission: the proposer may always refine their own pending proposal
  -- (mirrors withdraw); an approver may edit it too. "Approver" = a workspace
  -- admin/owner OR someone with write authority over the target — the same
  -- authority canvas_apply_edit ultimately relies on via the target-table RLS.
  -- The self-approval flag is irrelevant to editing.
  v_is_proposer := (v_edit.proposed_by = auth.uid());
  v_is_admin    := public.is_workspace_admin_or_owner(v_edit.workspace_id);
  if v_edit.slide_id is not null then
    select (owner_id = auth.uid() or created_by = auth.uid() or owner_id is null)
      into v_has_target
      from public.canvas_deck_slide where id = v_edit.slide_id;
  else
    select (created_by = auth.uid())
      into v_has_target
      from public.canvas_deck where id = v_edit.deck_id;
  end if;
  if not (v_is_proposer or v_is_admin or coalesce(v_has_target, false)) then
    raise exception 'canvas_update_edit: only the proposer or an approver may edit this proposal';
  end if;

  -- Re-base the diff to CURRENT target state so a reviewer always sees
  -- edit-vs-current after a revision (mirrors propose-time base capture, and
  -- keeps computeStaleness honest). Defaults preserve the existing base for
  -- kinds with no re-basable target (e.g. slide_delete).
  v_base_version_id := v_edit.base_version_id;
  v_base_theme_hash := v_edit.base_theme_css_hash;
  v_base_nav_hash   := v_edit.base_nav_js_hash;
  v_base_deck_title := v_edit.base_deck_title;

  if v_edit.kind in ('slide_edit', 'slide_html', 'slide_styles', 'slide_title')
     and v_edit.slide_id is not null then
    select current_version_id into v_base_version_id
      from public.canvas_deck_slide where id = v_edit.slide_id;
  elsif v_edit.kind = 'theme_css' then
    select md5(coalesce(theme_css, '')) into v_base_theme_hash
      from public.canvas_deck where id = v_edit.deck_id;
  elsif v_edit.kind = 'nav_js' then
    select md5(coalesce(nav_js, '')) into v_base_nav_hash
      from public.canvas_deck where id = v_edit.deck_id;
  elsif v_edit.kind = 'deck_title' then
    select title into v_base_deck_title
      from public.canvas_deck where id = v_edit.deck_id;
  end if;

  -- Per-kind content validation (mirrors propose-time + the CHECK constraint).
  -- Rationale is editable for EVERY kind; content is editable for the kinds
  -- that carry it. slide_delete has no editable content (rationale only).
  if v_edit.kind in ('slide_html', 'slide_styles', 'slide_title', 'theme_css', 'nav_js') then
    if _new_content is null then
      raise exception 'canvas_update_edit: kind % requires _new_content', v_edit.kind;
    end if;
  elsif v_edit.kind = 'deck_title' then
    if _new_content is null or length(trim(_new_content)) = 0 then
      raise exception 'canvas_update_edit: deck_title cannot be empty';
    end if;
  elsif v_edit.kind = 'slide_edit' then
    if _new_slide_payload is null
       or not (jsonb_typeof(_new_slide_payload->'html_body')    = 'string'
            or jsonb_typeof(_new_slide_payload->'slide_styles') = 'string'
            or jsonb_typeof(_new_slide_payload->'title')        = 'string') then
      raise exception 'canvas_update_edit: slide_edit requires at least one of html_body/slide_styles/title';
    end if;
  elsif v_edit.kind = 'slide_create' then
    if _new_slide_payload is null
       or jsonb_typeof(_new_slide_payload->'position')  <> 'number'
       or jsonb_typeof(_new_slide_payload->'html_body') <> 'string' then
      raise exception 'canvas_update_edit: slide_create requires position (number) and html_body (string)';
    end if;
  elsif v_edit.kind = 'slide_reorder' then
    if _new_slide_payload is null or jsonb_typeof(_new_slide_payload->'order') <> 'array' then
      raise exception 'canvas_update_edit: slide_reorder requires an order array';
    end if;
  end if;

  -- Authorize the content mutation past the immutability trigger for THIS
  -- UPDATE only (transaction-local). Cleared immediately after.
  perform set_config('canvas.allow_edit_content', '1', true);

  update public.canvas_deck_edit
     set new_content         = case
                                 when v_edit.kind in ('slide_edit', 'slide_create', 'slide_reorder', 'slide_delete')
                                   then new_content          -- payload kinds keep new_content null
                                 else _new_content
                               end,
         new_slide_payload   = case
                                 when v_edit.kind in ('slide_edit', 'slide_create', 'slide_reorder')
                                   then _new_slide_payload
                                 else new_slide_payload      -- text kinds keep payload null
                               end,
         rationale           = _rationale,
         base_version_id     = v_base_version_id,
         base_theme_css_hash = v_base_theme_hash,
         base_nav_js_hash    = v_base_nav_hash,
         base_deck_title     = v_base_deck_title,
         revision            = revision + 1,
         last_edited_at      = now(),
         last_edited_by      = auth.uid()
   where id = v_edit.id
   returning * into v_edit;

  perform set_config('canvas.allow_edit_content', '0', true);

  -- Audit breadcrumb in the comment thread so a reviewer who already opened the
  -- proposal sees it was revised (and the apply RPC's revision guard explains
  -- the rest).
  insert into public.canvas_edit_comment (workspace_id, edit_id, author_kind, author_id, body)
  values (v_edit.workspace_id, v_edit.id, 'user', auth.uid(),
          'Edited this proposal (revision ' || v_edit.revision || ').');

  return v_edit;
end;
$$;

revoke execute on function public.canvas_update_edit(uuid, text, jsonb, text, int) from public, anon;
grant  execute on function public.canvas_update_edit(uuid, text, jsonb, text, int) to authenticated;

-- ------------------------------------------------------------
-- 4. Add optimistic concurrency to canvas_apply_edit.
--    Re-created verbatim from the 0034 definition with two additions:
--    a new _expected_revision parameter and a revision-mismatch guard right
--    after the pending check. Every edit-kind branch is preserved exactly.
--
--    The old 1-arg signature is dropped first: adding a defaulted parameter
--    creates an overload, and PostgREST cannot disambiguate canvas_apply_edit
--    called with only _edit_id between the 1-arg and 2-arg forms. Dropping the
--    1-arg leaves a single function that the existing one-arg callers still
--    resolve to (the new param defaults to null = "skip the guard").
-- ------------------------------------------------------------
drop function if exists public.canvas_apply_edit(uuid);

create or replace function public.canvas_apply_edit(_edit_id uuid, _expected_revision int default null)
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

  -- Optimistic concurrency: if the caller passed the revision it reviewed,
  -- refuse to apply content that has since been edited out from under them.
  if _expected_revision is not null and v_edit.revision <> _expected_revision then
    raise exception 'canvas_apply_edit: proposal_changed_since_review (reviewed revision %, current %)',
      _expected_revision, v_edit.revision;
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

grant execute on function public.canvas_apply_edit(uuid, int) to authenticated;
