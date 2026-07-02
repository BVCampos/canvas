-- ============================================================
-- Audit the direct ADD ops in the deck activity feed — migration 0073
-- ============================================================
-- 0037 gave the activity feed one job: record slide DELETES, because the
-- canvas_deck_slide CASCADE erases every other trace of a deletion. Everything
-- else the history page derives at read time from the rows the action leaves
-- behind (canvas_deck_edit for proposals, canvas_slide_version for edits).
--
-- That read-time derivation has a blind spot the direct (non-proposal) add
-- paths opened. canvas_create_slide_direct (0061, the draw surface) and
-- canvas_duplicate_slide_direct (0071, in-app duplicate + the cross-deck copy
-- via copySlideFromDeck) insert a slide whose ONLY trace is a version_no = 1
-- row — and activity.ts deliberately skips version_no <= 1 as the slide's
-- import-time birth (listing 90 of them per import would be noise). So a drawn
-- or duplicated slide appeared in the deck with nobody credited: "who added
-- slide 7?" was as unanswerable as "who deleted slide 4?" was before 0037.
--
-- Fix, symmetric with 0037: widen the canvas_deck_activity action vocabulary to
-- cover the two additive ops, and have each direct-add RPC write an activity
-- row (same soft-ref, SECURITY DEFINER shape the delete trigger uses). The feed
-- then renders "added slide …" / "duplicated slide …" alongside the deletes.
-- The audit insert is wrapped so an activity-log hiccup can never block the
-- actual create/duplicate — the same stance 0037's trigger takes on delete.
--
-- Bodies are copied verbatim from 0061 / 0071 (CREATE OR REPLACE needs the whole
-- definition) plus the trailing activity insert; nothing else changes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Widen the action CHECK to admit the two additive verbs. The column-level
--    check from 0037 is auto-named canvas_deck_activity_action_check.
-- ------------------------------------------------------------
alter table public.canvas_deck_activity
  drop constraint canvas_deck_activity_action_check;
alter table public.canvas_deck_activity
  add constraint canvas_deck_activity_action_check
  check (action in ('slide_delete', 'slide_create', 'slide_duplicate'));

-- ------------------------------------------------------------
-- 2. canvas_create_slide_direct — body from 0061, plus a 'slide_create'
--    activity row crediting the drawer.
-- ------------------------------------------------------------
create or replace function public.canvas_create_slide_direct(
  _deck_id      uuid,
  _position     int,
  _title        text,
  _html_body    text,
  _slide_styles text default ''
)
returns public.canvas_deck_slide
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deck       public.canvas_deck;
  v_count      int;
  v_position   int;
  v_new_id     uuid;
  v_slide      public.canvas_deck_slide;
begin
  if auth.uid() is null then
    raise exception 'canvas_create_slide_direct: not authenticated';
  end if;

  select * into v_deck from public.canvas_deck where id = _deck_id;
  if not found then
    raise exception 'canvas_create_slide_direct: deck % not found', _deck_id;
  end if;

  -- The single authorization gate (DEFINER bypasses RLS).
  if not public.canvas_can_edit_deck(_deck_id) then
    raise exception 'canvas_create_slide_direct: not_authorized — you cannot edit deck %', _deck_id;
  end if;

  if _html_body is null or length(trim(_html_body)) = 0 then
    raise exception 'canvas_create_slide_direct: html_body cannot be empty';
  end if;

  select count(*) into v_count from public.canvas_deck_slide where deck_id = _deck_id;

  -- Clamp the insert position into [0, count]; count == append at the end.
  v_position := coalesce(_position, v_count);
  if v_position < 0 then v_position := 0; end if;
  if v_position > v_count then v_position := v_count; end if;

  -- Open the slot: push existing slides at/after the target right by one. The
  -- deferred unique constraint tolerates the transient collision until COMMIT.
  update public.canvas_deck_slide
     set position = position + 1
   where deck_id = _deck_id
     and position >= v_position;

  insert into public.canvas_deck_slide (
    workspace_id, deck_id, position, title, html_body, slide_styles,
    owner_id, created_by
  )
  values (
    v_deck.workspace_id, _deck_id, v_position,
    coalesce(_title, ''), _html_body, coalesce(_slide_styles, ''),
    -- owner_id null = unowned, so any deck editor (incl. the creator) can later
    -- direct-edit it. Matches the slide_create apply path.
    null,
    auth.uid()
  )
  returning id into v_new_id;

  -- Re-read so the row carries current_version_id, which the AFTER-INSERT
  -- init-version trigger (0002) populates out of band.
  select * into v_slide from public.canvas_deck_slide where id = v_new_id;

  -- Audit the additive op (0073) — same soft-ref shape as the 0037 delete row.
  -- Swallowed like the delete trigger: an audit hiccup must not block the draw.
  begin
    insert into public.canvas_deck_activity (
      workspace_id, deck_id, slide_id, action,
      actor_id, actor_kind, subject_user_id, detail
    )
    values (
      v_deck.workspace_id, _deck_id, v_new_id, 'slide_create',
      auth.uid(), 'user', null,
      jsonb_strip_nulls(jsonb_build_object(
        'slide_title', v_slide.title,
        'position', v_slide.position
      ))
    );
  exception when others then
    raise warning 'canvas_create_slide_direct: activity log failed: % (slide %)', sqlerrm, v_new_id;
  end;

  return v_slide;
end;
$$;

revoke execute on function public.canvas_create_slide_direct(uuid, int, text, text, text) from public, anon;
grant  execute on function public.canvas_create_slide_direct(uuid, int, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 3. canvas_duplicate_slide_direct — body from 0071, plus a 'slide_duplicate'
--    activity row that also names the source slide (so the feed can read
--    "duplicated slide 3 …").
-- ------------------------------------------------------------
create or replace function public.canvas_duplicate_slide_direct(
  _slide_id uuid
)
returns public.canvas_deck_slide
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.canvas_deck_slide;
  v_new_id uuid;
  v_slide  public.canvas_deck_slide;
begin
  if auth.uid() is null then
    raise exception 'canvas_duplicate_slide_direct: not authenticated';
  end if;

  select * into v_source from public.canvas_deck_slide where id = _slide_id;
  if not found then
    raise exception 'canvas_duplicate_slide_direct: slide % not found', _slide_id;
  end if;

  -- The single authorization gate (DEFINER bypasses RLS).
  if not public.canvas_can_edit_deck(v_source.deck_id) then
    raise exception 'canvas_duplicate_slide_direct: not_authorized — you cannot edit deck %', v_source.deck_id;
  end if;

  -- Open the slot right after the source. The deferred unique constraint
  -- tolerates the transient collisions until COMMIT.
  update public.canvas_deck_slide
     set position = position + 1
   where deck_id = v_source.deck_id
     and position > v_source.position;

  insert into public.canvas_deck_slide (
    workspace_id, deck_id, position, title, html_body, slide_styles,
    owner_id, created_by
  )
  values (
    v_source.workspace_id, v_source.deck_id, v_source.position + 1,
    v_source.title, v_source.html_body, coalesce(v_source.slide_styles, ''),
    -- owner_id null = unowned, so any deck editor can immediately work the
    -- copy. Matches canvas_create_slide_direct and the slide_create apply path.
    null,
    auth.uid()
  )
  returning id into v_new_id;

  -- Re-read so the row carries current_version_id, which the AFTER-INSERT
  -- init-version trigger (0002) populates out of band.
  select * into v_slide from public.canvas_deck_slide where id = v_new_id;

  -- Audit the additive op (0073) — same soft-ref shape as the 0037 delete row,
  -- plus the source slide so the feed reads "duplicated slide N". Swallowed so
  -- an audit hiccup can't block the copy.
  begin
    insert into public.canvas_deck_activity (
      workspace_id, deck_id, slide_id, action,
      actor_id, actor_kind, subject_user_id, detail
    )
    values (
      v_source.workspace_id, v_source.deck_id, v_new_id, 'slide_duplicate',
      auth.uid(), 'user', null,
      jsonb_strip_nulls(jsonb_build_object(
        'slide_title', v_slide.title,
        'position', v_slide.position,
        'source_slide_id', v_source.id,
        'source_slide_title', v_source.title
      ))
    );
  exception when others then
    raise warning 'canvas_duplicate_slide_direct: activity log failed: % (slide %)', sqlerrm, v_new_id;
  end;

  return v_slide;
end;
$$;

revoke execute on function public.canvas_duplicate_slide_direct(uuid) from public, anon;
grant  execute on function public.canvas_duplicate_slide_direct(uuid) to authenticated;
