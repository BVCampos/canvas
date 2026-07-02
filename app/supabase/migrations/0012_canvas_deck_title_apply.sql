-- ============================================================
-- Canvas deck_title proposals — apply path (migration 0012)
-- ============================================================
-- Wires the 'deck_title' edit kind (added in 0011) into the proposal
-- workflow. A deck_title proposal carries the proposed title in the
-- existing text `new_content` column — same shape as theme_css / nav_js
-- — because a title is a single short text value with no structured
-- sub-fields.
--
-- On approval, canvas_apply_edit updates canvas_deck.title in place.
-- There is no per-title version history table: title changes are rare
-- and the proposal row itself (status=applied + new_content) serves as
-- the audit trail. The RPC's return-type contract still resolves to
-- canvas_slide_version, so the deck_title branch leaves v_new unset —
-- mirrors the theme_css / nav_js convention where the caller treats a
-- null return as "no slide-version row for this kind".
--
-- A new base-state column (base_deck_title) captures the deck's title
-- at propose time so the reviewer's stale-base detection works even if
-- the title changes between propose and approve. We don't index it —
-- title changes are infrequent and no query needs lookup by base value.
-- ============================================================

-- ============================================================
-- 1. Base-state capture column
-- ============================================================
-- Nullable: only deck_title proposals populate it. Matches the
-- nullable shape of base_theme_css_hash / base_nav_js_hash.

alter table public.canvas_deck_edit
  add column base_deck_title text;

-- ============================================================
-- 2. Shape CHECK extension
-- ============================================================
-- The 0010 constraint encoded the per-kind invariant that slide_create
-- rows carry new_slide_payload and everything else carries new_content.
-- We drop and recreate it to add 'deck_title' to the new_content-shaped
-- bucket (alongside slide_html / slide_styles / theme_css / nav_js).

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
  );

-- ============================================================
-- 3. Extend the immutability trigger
-- ============================================================
-- The 0010 trigger locks every input column on canvas_deck_edit so the
-- reviewer's diff cannot be mutated between propose and approve. We
-- extend the lock to cover base_deck_title so deck_title proposals get
-- the same guarantee as base_theme_css_hash / base_nav_js_hash.

create or replace function public.canvas_deck_edit_enforce_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
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

-- Triggers don't check EXECUTE on their bound function, so revoking
-- REST access just removes the /rest/v1/rpc surface (matches 0008/0010).
revoke execute on function public.canvas_deck_edit_enforce_immutability() from public, anon, authenticated;

-- ============================================================
-- 4. Extend canvas_apply_edit with the deck_title branch
-- ============================================================
-- Adds the new branch after nav_js so the deck-level kinds stay
-- grouped at the bottom. The rest of the function body matches 0010
-- verbatim — preserved here because CREATE OR REPLACE FUNCTION
-- replaces the whole body.

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
    -- CHECK constraint added in this migration; title and slide_styles
    -- default to '' if absent (matches canvas_deck_slide defaults).
    v_position     := (v_edit.new_slide_payload->>'position')::int;
    v_title        := coalesce(v_edit.new_slide_payload->>'title', '');
    v_html_body    := v_edit.new_slide_payload->>'html_body';
    v_slide_styles := coalesce(v_edit.new_slide_payload->>'slide_styles', '');

    if v_position < 0 then
      raise exception 'canvas_apply_edit: slide_create position must be >= 0 (got %)', v_position;
    end if;

    -- Shift existing slides at >= v_position up by 1 to open the slot.
    -- The (deck_id, position) unique constraint on canvas_deck_slide is
    -- DEFERRABLE INITIALLY DEFERRED, so transient collisions resolve at
    -- COMMIT.
    update public.canvas_deck_slide
       set position = position + 1
     where deck_id = v_edit.deck_id
       and position >= v_position;

    -- Insert at the requested slot. owner_id is null by design — the new
    -- slide is unowned so any workspace member can subsequently propose
    -- edits against it (matches the importer's behaviour). The
    -- canvas_deck_slide_init_version_trg trigger creates version_no=1
    -- and points current_version_id at it.
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

    -- Surface the v1 row produced by the init trigger so the RPC's
    -- return type stays meaningful for slide_create callers.
    select * into v_new
      from public.canvas_slide_version
     where slide_id = v_new_slide_id
     order by version_no desc
     limit 1;

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

-- Re-pin the REST grants (matches 0008/0010's tightening of the same function).
revoke execute on function public.canvas_apply_edit(uuid) from public, anon;
grant  execute on function public.canvas_apply_edit(uuid) to   authenticated;
