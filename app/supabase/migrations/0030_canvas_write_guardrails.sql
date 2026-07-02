-- ============================================================
-- Production guardrails for RLS-filtered write no-ops
-- ============================================================
-- Supabase/PostgREST UPDATE and DELETE operations filtered by RLS can affect
-- zero rows without raising an error. These RPCs perform multi-step mutations,
-- so a zero-row live-row update must abort the transaction rather than let the
-- UI report success while the deck stayed unchanged.
-- ============================================================

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

create or replace function public.canvas_restore_slide_version(_slide_id uuid, _to_version_id uuid)
returns public.canvas_slide_version
language plpgsql
set search_path = public
as $$
declare
  v_slide    public.canvas_deck_slide;
  v_source   public.canvas_slide_version;
  v_new_no   int;
  v_new      public.canvas_slide_version;
  v_rowcount int;
begin
  select * into v_slide from public.canvas_deck_slide where id = _slide_id;
  if not found then
    raise exception 'canvas_restore_slide_version: slide % not found', _slide_id;
  end if;

  select * into v_source from public.canvas_slide_version where id = _to_version_id;
  if not found then
    raise exception 'canvas_restore_slide_version: source version % not found', _to_version_id;
  end if;

  if v_source.slide_id <> v_slide.id then
    raise exception 'canvas_restore_slide_version: source version belongs to a different slide';
  end if;

  select coalesce(max(version_no), 0) + 1
    into v_new_no
    from public.canvas_slide_version
   where slide_id = v_slide.id;

  insert into public.canvas_slide_version (
    workspace_id, deck_id, slide_id, version_no, parent_version_id,
    title, html_body, slide_styles,
    author_kind, created_by, source_prompt
  )
  values (
    v_slide.workspace_id, v_slide.deck_id, v_slide.id, v_new_no, v_slide.current_version_id,
    v_source.title, v_source.html_body, v_source.slide_styles,
    'user',
    auth.uid(),
    format('restored from v%s', v_source.version_no)
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
    raise exception 'canvas_restore_slide_version: slide update touched no rows for slide %', v_slide.id;
  end if;

  return v_new;
end;
$$;

create or replace function public.canvas_restore_snapshot(_snapshot_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_snapshot public.canvas_deck_snapshot;
  v_count    int := 0;
  r          record;
  v_source   public.canvas_slide_version;
  v_new_no   int;
  v_new_id   uuid;
  v_rowcount int;
begin
  select * into v_snapshot from public.canvas_deck_snapshot where id = _snapshot_id;
  if not found then
    raise exception 'canvas_restore_snapshot: snapshot % not found', _snapshot_id;
  end if;

  perform public.canvas_create_snapshot(
    v_snapshot.deck_id,
    format('Pre-restore safety net (was about to restore "%s")', v_snapshot.label),
    null,
    'pre_restore'
  );

  update public.canvas_deck
    set theme_css = v_snapshot.theme_css,
        nav_js    = v_snapshot.nav_js
    where id = v_snapshot.deck_id;

  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    raise exception 'canvas_restore_snapshot: deck update touched no rows for deck %', v_snapshot.deck_id;
  end if;

  for r in (
    select ss.slide_version_id, ss.position
      from public.canvas_deck_snapshot_slide ss
     where ss.snapshot_id = _snapshot_id
     order by ss.position
  ) loop
    select * into v_source from public.canvas_slide_version where id = r.slide_version_id;
    if not found then continue; end if;

    if not exists (select 1 from public.canvas_deck_slide where id = v_source.slide_id) then
      continue;
    end if;

    select coalesce(max(version_no), 0) + 1
      into v_new_no
      from public.canvas_slide_version
     where slide_id = v_source.slide_id;

    v_new_id := null;
    insert into public.canvas_slide_version (
      workspace_id, deck_id, slide_id, version_no, parent_version_id,
      title, html_body, slide_styles,
      author_kind, created_by, source_prompt
    )
    select s.workspace_id, s.deck_id, s.id, v_new_no, s.current_version_id,
           v_source.title, v_source.html_body, v_source.slide_styles,
           'user', auth.uid(),
           format('restored from snapshot %L', v_snapshot.label)
      from public.canvas_deck_slide s
     where s.id = v_source.slide_id
    returning id into v_new_id;

    if v_new_id is null then
      raise exception 'canvas_restore_snapshot: version insert touched no rows for slide %', v_source.slide_id;
    end if;

    update public.canvas_deck_slide
      set title              = v_source.title,
          html_body          = v_source.html_body,
          slide_styles       = v_source.slide_styles,
          current_version_id = v_new_id
      where id = v_source.slide_id;

    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_restore_snapshot: slide update touched no rows for slide %', v_source.slide_id;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.canvas_apply_edit(uuid) from public, anon;
grant  execute on function public.canvas_apply_edit(uuid) to authenticated;

revoke execute on function public.canvas_restore_slide_version(uuid, uuid) from public, anon;
grant  execute on function public.canvas_restore_slide_version(uuid, uuid) to authenticated;

revoke execute on function public.canvas_restore_snapshot(uuid) from public, anon;
grant  execute on function public.canvas_restore_snapshot(uuid) to authenticated;
