-- ============================================================
-- Direct (non-proposal) structural slide ops — migration 0061
-- ============================================================
-- Until now the ONLY way to CREATE or REORDER slides was the propose -> approve
-- loop (canvas_apply_edit handling the slide_create / slide_reorder kinds). That
-- is right for content edits, which CLOBBER and need a reviewer to see WHAT
-- changed. Position and additive-blank-slide are different: a reorder is purely
-- positional and trivially reversible (drag it back), and a freshly drawn slide
-- is additive — neither overwrites anyone's content. So this adds a parallel
-- DIRECT path for the two structural ops, mirroring canvas_save_slide_direct
-- (0033): the deck editor's drag-to-reorder and "draw a new slide" apply
-- immediately instead of queuing a proposal the same person then self-approves.
-- The MCP propose_reorder_slides / propose_new_slide tools are untouched — an
-- agent still proposes; only the in-app human-editor path goes direct. See
-- ADR-0012.
--
-- Authorization: both are SECURITY DEFINER (they rewrite positions across slides
-- the caller may not individually own, so SECURITY INVOKER + the per-slide
-- canvas_deck_slide UPDATE RLS would wrongly block a deck editor reordering a
-- teammate's slide). The DEFINER body bypasses RLS, so the EXPLICIT
-- canvas_can_edit_deck(_deck_id) check IS the gate — exactly the pattern
-- canvas_apply_edit uses (and the pglite harness exercises). auth.uid() still
-- resolves to the caller inside a DEFINER function, so canvas_can_edit_deck
-- evaluates for the real user.
--
-- Both lean on the (deck_id, position) unique constraint being
-- `deferrable initially deferred` (migration 0001): the create's "shift later
-- slides right by one" and the reorder's full position rewrite pass through
-- transient duplicate positions that are only checked at COMMIT.
-- ============================================================

-- ------------------------------------------------------------
-- canvas_create_slide_direct — insert a slide at a position, shifting the rest
-- right, and return the new (trigger-versioned) row. Used by the in-app draw
-- surface to land a freshly drawn slide without a proposal.
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
  return v_slide;
end;
$$;

revoke execute on function public.canvas_create_slide_direct(uuid, int, text, text, text) from public, anon;
grant  execute on function public.canvas_create_slide_direct(uuid, int, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- canvas_reorder_slides_direct — rewrite every slide's position from an ordered
-- array of slide ids (an exact permutation of the deck's slides). Backs the
-- left-rail drag-to-reorder. Returns the number of slides reordered.
-- ------------------------------------------------------------
create or replace function public.canvas_reorder_slides_direct(
  _deck_id uuid,
  _order   uuid[]
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deck_count  int;
  v_order_count int;
  v_rowcount    int;
begin
  if auth.uid() is null then
    raise exception 'canvas_reorder_slides_direct: not authenticated';
  end if;

  if not exists (select 1 from public.canvas_deck where id = _deck_id) then
    raise exception 'canvas_reorder_slides_direct: deck % not found', _deck_id;
  end if;

  if not public.canvas_can_edit_deck(_deck_id) then
    raise exception 'canvas_reorder_slides_direct: not_authorized — you cannot edit deck %', _deck_id;
  end if;

  select count(*) into v_deck_count from public.canvas_deck_slide where deck_id = _deck_id;
  v_order_count := coalesce(array_length(_order, 1), 0);

  -- Validate an EXACT permutation: same length, no duplicates, and every id in
  -- the deck. (length match + all-in-deck + distinct ⇒ every current slide is
  -- referenced exactly once.) Same contract canvas_apply_edit enforces, so the
  -- direct and proposal reorder paths can never diverge.
  if v_order_count <> v_deck_count then
    raise exception 'canvas_reorder_slides_direct: order must list all % slide(s) exactly once (got %)', v_deck_count, v_order_count;
  end if;
  if (select count(distinct x) from unnest(_order) as x) <> v_order_count then
    raise exception 'canvas_reorder_slides_direct: order contains duplicate slide ids';
  end if;
  if exists (
    select 1 from unnest(_order) as x
    where not exists (
      select 1 from public.canvas_deck_slide s where s.id = x and s.deck_id = _deck_id
    )
  ) then
    raise exception 'canvas_reorder_slides_direct: order references a slide not in deck %', _deck_id;
  end if;

  -- Rewrite to the 0-based index in `_order`. The deferred unique constraint
  -- lets the positions pass through transient collisions until COMMIT.
  update public.canvas_deck_slide s
     set position = m.ord - 1
    from unnest(_order) with ordinality as m(sid, ord)
   where s.id = m.sid
     and s.deck_id = _deck_id;

  get diagnostics v_rowcount = row_count;
  if v_rowcount <> v_deck_count then
    raise exception 'canvas_reorder_slides_direct: rewrote % of % slide(s)', v_rowcount, v_deck_count;
  end if;

  return v_rowcount;
end;
$$;

revoke execute on function public.canvas_reorder_slides_direct(uuid, uuid[]) from public, anon;
grant  execute on function public.canvas_reorder_slides_direct(uuid, uuid[]) to authenticated;
