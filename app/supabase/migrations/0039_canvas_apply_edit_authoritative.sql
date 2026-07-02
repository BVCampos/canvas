-- ============================================================
-- Canvas authoritative apply — migration 0039
-- ============================================================
-- Approval is the permission boundary, but canvas_apply_edit ran SECURITY
-- INVOKER: every target-table write re-ran under the APPROVER's row-level
-- policies. Those per-row policies carry creator/owner conditions the proposal
-- model doesn't know about, so an approvable proposal could fail to apply
-- depending on who clicked Approve:
--
--   * canvas_deck_slide DELETE policy is `workspace admin OR (deck editor AND
--     created_by = me)` — a workspace member approving a slide_delete on a
--     slide imported by someone else got `delete ... 0 rows` and the opaque
--     "removed no rows" exception. (Prod, 2026-06-11: 8 failed Approve clicks
--     across two proposals until an owner clicked the same button.)
--   * canvas_deck_slide UPDATE policy has the same shape for owned slides.
--
-- This migration recreates canvas_apply_edit as SECURITY DEFINER with the
-- authorization made EXPLICIT at the top, instead of implicit-and-stricter at
-- each write:
--
--   1. caller must be authenticated;
--   2. caller must pass canvas_can_edit_deck(deck_id) — the exact authority
--      that already gates proposal resolution (RLS "editors resolve edits"
--      lets any deck editor flip status), so nobody gains approval rights
--      they didn't have; they only stop losing the APPLY half of it;
--   3. the pending / revision / self-approval guards are unchanged.
--
-- After those checks the per-kind writes run as definer, so a decision that
-- the proposal layer accepts always lands. The rowcount guards are kept as
-- anomaly backstops (they no longer encode permissions).
--
-- The function body is otherwise carried verbatim from 0035.
-- ============================================================

create or replace function public.canvas_apply_edit(_edit_id uuid, _expected_revision int default null)
returns public.canvas_slide_version
language plpgsql
security definer
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
  -- Definer mode: the SELECT below is no longer RLS-filtered, so access is
  -- enforced explicitly. Same not-found message for missing and inaccessible
  -- edits, to avoid turning this into an existence oracle.
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found
     or auth.uid() is null
     or not public.canvas_can_edit_deck(v_edit.deck_id) then
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
      raise exception 'canvas_apply_edit: slide_reorder could not rewrite all slides';
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
      raise exception 'canvas_apply_edit: slide_delete removed no rows';
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

revoke execute on function public.canvas_apply_edit(uuid, int) from public, anon;
grant  execute on function public.canvas_apply_edit(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- canvas_update_edit: align the "approver may edit a proposal" rule with the
-- same authority. 0035 derived approver-ship from per-row slide owner/creator
-- columns (the leaky model 0039 retires); now an approver IS anyone who passes
-- canvas_can_edit_deck, matching canvas_apply_edit above. Body otherwise
-- carried verbatim from 0035 (still SECURITY INVOKER — the UPDATE rides the
-- "editors resolve edits" RLS policy, which is the same predicate).
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
  v_is_approver     boolean;
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
  -- (mirrors withdraw); an approver may edit it too. "Approver" = anyone who
  -- passes canvas_can_edit_deck — the authority canvas_apply_edit checks.
  v_is_proposer := (v_edit.proposed_by = auth.uid());
  v_is_approver := public.canvas_can_edit_deck(v_edit.deck_id);
  if not (v_is_proposer or v_is_approver) then
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
