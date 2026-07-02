-- ============================================================
-- Direct duplicate + delete for deck editors — migration 0071
-- ============================================================
-- Finishes what 0061 (ADR-0012) started. Reorder and draw-create went direct
-- on the argument "additive / trivially reversible ops don't need review" —
-- but duplicate (also purely additive) and delete still inserted a proposal
-- the same person then self-approved: two full propose→approve cycles to copy
-- one slide (speed discovery 2026-07 #6). This adds the two missing DIRECT
-- RPCs, same shape as 0061: SECURITY DEFINER with the EXPLICIT
-- canvas_can_edit_deck check as the one gate (auth.uid() resolves to the real
-- caller inside a DEFINER body).
--
-- Delete is the op to be deliberate about: it destroys content, but it is
-- recoverable via deck snapshots (History restore), the pre-delete versions
-- live on in any snapshot that references them, and the 0037 BEFORE DELETE
-- trigger still writes the canvas_deck_activity audit row no matter which
-- path deleted the slide. The proposal path (propose_delete_slide) remains
-- for agents and members without direct edit rights.
--
-- Both ops lean on the (deck_id, position) unique constraint being
-- `deferrable initially deferred` (0001) for the shift/compact rewrites.
-- ============================================================

-- ------------------------------------------------------------
-- canvas_duplicate_slide_direct — copy a slide in place (content verbatim,
-- server-side) and insert the copy right AFTER its source, shifting later
-- slides right. Returns the new (trigger-versioned) row. Speaker notes do NOT
-- travel with a copy (same contract as the propose/copy tools).
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
  return v_slide;
end;
$$;

revoke execute on function public.canvas_duplicate_slide_direct(uuid) from public, anon;
grant  execute on function public.canvas_duplicate_slide_direct(uuid) to authenticated;

-- ------------------------------------------------------------
-- canvas_delete_slide_direct — delete a slide and close the position gap.
-- Mirrors canvas_apply_edit's slide_delete branch exactly (only-slide guard,
-- delete, compact left) so the direct and proposal paths cannot diverge.
-- Returns the deleted slide's position.
-- ------------------------------------------------------------
create or replace function public.canvas_delete_slide_direct(
  _slide_id uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slide    public.canvas_deck_slide;
  v_rowcount int;
begin
  if auth.uid() is null then
    raise exception 'canvas_delete_slide_direct: not authenticated';
  end if;

  select * into v_slide from public.canvas_deck_slide where id = _slide_id;
  if not found then
    raise exception 'canvas_delete_slide_direct: slide % not found (already deleted?)', _slide_id;
  end if;

  if not public.canvas_can_edit_deck(v_slide.deck_id) then
    raise exception 'canvas_delete_slide_direct: not_authorized — you cannot edit deck %', v_slide.deck_id;
  end if;

  if (select count(*) from public.canvas_deck_slide where deck_id = v_slide.deck_id) <= 1 then
    raise exception 'canvas_delete_slide_direct: cannot delete the deck''s only slide';
  end if;

  -- The 0037 BEFORE DELETE trigger writes the canvas_deck_activity audit row
  -- (slide deletions CASCADE-erase their versions/comments, so the activity
  -- row is the surviving trail) — it fires for this path too.
  delete from public.canvas_deck_slide where id = v_slide.id;

  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    raise exception 'canvas_delete_slide_direct: delete removed no rows';
  end if;

  update public.canvas_deck_slide
     set position = position - 1
   where deck_id = v_slide.deck_id
     and position > v_slide.position;

  return v_slide.position;
end;
$$;

revoke execute on function public.canvas_delete_slide_direct(uuid) from public, anon;
grant  execute on function public.canvas_delete_slide_direct(uuid) to authenticated;
