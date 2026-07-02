-- ============================================================
-- Canvas structural slide ops — apply path (migration 0024)
-- ============================================================
-- Wires slide_reorder + slide_delete (enum values added in 0023) into the
-- proposal workflow. Both route through the normal propose -> approve cycle
-- (they're structurally destructive, so the human-in-the-loop review, the
-- immutable diff, and the audit trail are exactly what we want).
--
--   slide_reorder: new_slide_payload = { "order": ["<slide_id>", ...] }.
--                  On approve, positions are rewritten to the 0-based index in
--                  `order`. Validated as an EXACT permutation of the deck's
--                  current slides (re-checked at apply time so a slide
--                  added/removed since propose fails loudly, not silently).
--   slide_delete:  slide_id identifies the slide to remove. On approve the
--                  slide is deleted (cascading its version chain / locks /
--                  comments / pending edits, per the 0001 ON DELETE CASCADE)
--                  and trailing positions are decremented to stay 0-based
--                  contiguous. Blocked if it would leave the deck with zero
--                  slides. Neither op produces a canvas_slide_version, so the
--                  RPC leaves v_new unset (matches theme_css / nav_js /
--                  deck_title).
--
-- This re-emits canvas_apply_edit verbatim from 0012 plus the two new branches
-- (CREATE OR REPLACE FUNCTION replaces the whole body) and extends the
-- content-shape CHECK. The immutability trigger is unchanged: reorder's payload
-- is locked by the existing new_slide_payload guard, and delete carries no
-- mutable content.
-- ============================================================

-- ============================================================
-- 1. Shape CHECK extension
-- ============================================================
-- Adds the reorder bucket (structured `order` array in new_slide_payload) and
-- the delete bucket (no content, no payload — slide_id carries the target).

alter table public.canvas_deck_edit
  drop constraint canvas_deck_edit_content_shape_chk;

alter table public.canvas_deck_edit
  add constraint canvas_deck_edit_content_shape_chk check (
    (
      kind in ('slide_html', 'slide_styles', 'theme_css', 'nav_js', 'deck_title')
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
  );

-- ============================================================
-- 2. Extend canvas_apply_edit with the slide_reorder + slide_delete branches
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

  elsif v_edit.kind = 'slide_create' then
    -- Decode payload. position + html_body are guaranteed present by the
    -- CHECK constraint; title and slide_styles default to '' if absent.
    v_position     := (v_edit.new_slide_payload->>'position')::int;
    v_title        := coalesce(v_edit.new_slide_payload->>'title', '');
    v_html_body    := v_edit.new_slide_payload->>'html_body';
    v_slide_styles := coalesce(v_edit.new_slide_payload->>'slide_styles', '');

    if v_position < 0 then
      raise exception 'canvas_apply_edit: slide_create position must be >= 0 (got %)', v_position;
    end if;

    -- Shift existing slides at >= v_position up by 1 to open the slot. The
    -- (deck_id, position) unique constraint is DEFERRABLE INITIALLY DEFERRED,
    -- so transient collisions resolve at COMMIT.
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

  elsif v_edit.kind = 'slide_reorder' then
    -- new_slide_payload->'order' is the deck's slides in target order. Re-check
    -- it's an EXACT permutation of the deck's CURRENT slides (a slide may have
    -- been added/removed since propose): same count, all ids belong to the
    -- deck, no duplicates. Anything else fails loudly rather than half-applying.
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

    -- Rewrite positions to the 0-based index in `order`. The DEFERRABLE
    -- (deck_id, position) unique constraint lets the transient collisions
    -- during the rewrite resolve at COMMIT.
    update public.canvas_deck_slide s
       set position = (m.ord - 1)
      from (
        select value::uuid as sid, ord
          from jsonb_array_elements_text(v_edit.new_slide_payload->'order')
               with ordinality as t(value, ord)
      ) m
     where s.id = m.sid and s.deck_id = v_edit.deck_id;

    -- canvas_apply_edit is SECURITY INVOKER, so this UPDATE runs under the
    -- approver's RLS. If the slide-UPDATE policy filtered any rows the approver
    -- can't write, the rewrite would be partial and collide at COMMIT with an
    -- opaque deferred-unique error. Assert we touched every slide and fail with
    -- a clear message (rolling back) otherwise.
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

    -- Never leave a deck with zero slides — the assembler/preview assume >= 1.
    if (select count(*) from public.canvas_deck_slide where deck_id = v_edit.deck_id) <= 1 then
      raise exception 'canvas_apply_edit: cannot delete the deck''s only slide';
    end if;

    -- Deleting the slide cascades its version chain, locks, comments, and any
    -- pending edits on it (the 0001 canvas_deck_slide FKs are ON DELETE
    -- CASCADE) — INCLUDING this slide_delete proposal row itself (its slide_id
    -- points at the deleted slide). That is intentional: the deletion is the
    -- point, the proposal consumes itself, and the moot status-update below
    -- simply matches 0 rows. Approving a delete therefore discards that slide's
    -- history; the MCP tool description warns about it.
    delete from public.canvas_deck_slide where id = v_slide.id;

    -- SECURITY INVOKER: this DELETE runs under the approver's RLS, and the slide
    -- DELETE policy is narrower than the proposal-approve UI affordance — a row
    -- the approver can't delete is SILENTLY filtered (RLS DELETE never raises),
    -- which would otherwise mark this proposal applied without deleting
    -- anything. Assert the target was actually removed; fail loudly (rolling
    -- back the status='applied' below) otherwise.
    get diagnostics v_rowcount = row_count;
    if v_rowcount = 0 then
      raise exception 'canvas_apply_edit: slide_delete removed no rows — you may not have permission to delete this slide, or it was already deleted';
    end if;

    -- Close the gap so positions stay 0-based contiguous (mirrors the
    -- slide_create shift). DEFERRABLE uq makes the decrement safe in-txn.
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

  elsif v_edit.kind = 'nav_js' then
    select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
    if not found then
      raise exception 'canvas_apply_edit: deck % not found', v_edit.deck_id;
    end if;

    update public.canvas_deck
      set nav_js = v_edit.new_content
      where id = v_deck.id;

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

-- Re-pin the REST grants (matches 0008/0010/0012's tightening of this function).
revoke execute on function public.canvas_apply_edit(uuid) from public, anon;
grant  execute on function public.canvas_apply_edit(uuid) to   authenticated;
