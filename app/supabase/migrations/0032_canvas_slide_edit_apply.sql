-- ============================================================
-- Canvas bundled slide edit — shape CHECK + apply path (migration 0032)
-- ============================================================
-- Wires the 'slide_edit' kind (added in 0031) into the proposal workflow.
--
-- A slide_edit proposal carries its content in new_slide_payload (jsonb) as
-- any non-empty subset of { html_body, slide_styles, title } — only the fields
-- the proposer touched. On approval canvas_apply_edit merges those fields onto
-- the slide's CURRENT state in a single new canvas_slide_version (a key absent
-- from the payload keeps the current value; an explicit "" clears the field,
-- matching the single-field slide_styles / slide_title semantics).
-- ============================================================

-- ============================================================
-- 1. Extend the content-shape CHECK
-- ============================================================
-- This is 0029's canvas_deck_edit_content_shape_chk (an explicit allowlist of
-- the new_content-bearing kinds, plus per-kind payload branches for
-- slide_create / slide_reorder / slide_delete) with ONE new branch added:
-- slide_edit rides new_content=null + new_slide_payload carrying at least one
-- of html_body / slide_styles / title (each a string). The slide_reorder and
-- slide_delete branches MUST be preserved verbatim — they also use null
-- new_content, so a coarser "kind <> slide_create" rule would break them.

alter table public.canvas_deck_edit
  drop constraint canvas_deck_edit_content_shape_chk;

alter table public.canvas_deck_edit
  add constraint canvas_deck_edit_content_shape_chk check (
    (
      kind in ('slide_html', 'slide_styles', 'slide_title', 'theme_css', 'nav_js', 'deck_title')
      and new_content is not null
      and new_slide_payload is null
    )
    or (
      kind = 'slide_create'
      and new_content is null
      and new_slide_payload is not null
      and jsonb_typeof(new_slide_payload->'position') = 'number'
      and jsonb_typeof(new_slide_payload->'html_body') = 'string'
    )
    or (
      kind = 'slide_reorder'
      and new_content is null
      and new_slide_payload is not null
      and jsonb_typeof(new_slide_payload->'order') = 'array'
    )
    or (
      kind = 'slide_delete'
      and new_content is null
      and new_slide_payload is null
    )
    or (
      kind = 'slide_edit'
      and new_content is null
      and new_slide_payload is not null
      and (
        jsonb_typeof(new_slide_payload->'html_body') = 'string'
        or jsonb_typeof(new_slide_payload->'slide_styles') = 'string'
        or jsonb_typeof(new_slide_payload->'title') = 'string'
      )
    )
  );

-- ============================================================
-- 2. Extend canvas_apply_edit with the slide_edit branch
-- ============================================================
-- CREATE OR REPLACE swaps the whole body, so this is 0030's function verbatim
-- with one new branch (slide_edit) inserted right after the single-field
-- slide_html/slide_styles/slide_title branch. Everything else — the
-- self-approval guard, the structural/theme/nav/deck_title branches, the
-- zero-row guardrails, and the applied-status update — is unchanged from 0030.

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

  if v_edit.proposed_by = auth.uid()
     and not public.is_workspace_admin_or_owner(v_edit.workspace_id) then
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
    -- Bundled slide edit. Merge whatever fields the payload carries onto the
    -- slide's current state into a single new version. A key missing from the
    -- payload (->> returns NULL) falls back to the current value via coalesce;
    -- an explicit "" clears the field (a string, so it overrides the current
    -- value rather than coalescing away).
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

  -- A slide_delete proposal row is removed by the slide_id cascade. All other
  -- proposal kinds must survive long enough to be marked applied.
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

revoke execute on function public.canvas_apply_edit(uuid) from public, anon;
grant  execute on function public.canvas_apply_edit(uuid) to authenticated;
