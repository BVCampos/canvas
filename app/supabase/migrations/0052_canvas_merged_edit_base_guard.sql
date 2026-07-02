-- ============================================================
-- Harden canvas_apply_merged_edit: validate the merge's declared base — 0052
-- ============================================================
-- canvas_apply_merged_edit (0050) applies a precomputed 3-way merge. It already
-- guards authority, self-approval, pending-status, and optimistic concurrency
-- (the slide hasn't advanced past the version the merge was computed on,
-- _expected_current_version_id). But it trusted the caller on one axis: it never
-- checked that the proposal's RECORDED base (canvas_deck_edit.base_version_id —
-- the version the merge's "base" input came from) is consistent with that
-- current version. The sole caller (lib/canvas/merge-actions) loads all three
-- sides under RLS, so this is bounded today — but a future second caller or an
-- app-side (base, current) pairing bug could commit a merge whose base belongs
-- to another slide or postdates current, with no DB catch.
--
-- This adds that defense. The function still can't recompute the app's node-diff3
-- merge (it only receives the result), but a SOUND merge's base must be a version
-- of THIS slide at or before the current version it was merged onto. Per-slide
-- history is linear — each version parents off the current one with a monotonic
-- version_no, and (slide_id, version_no) is unique — so "current descends from
-- base" is exactly "same slide AND base.version_no <= current.version_no". A
-- mismatch raises merge_base_invalid. Skipped only for legacy proposals that
-- carry no base_version_id; the merge_base_moved guard still applies there.
--
-- CREATE OR REPLACE: a behaviour-preserving tightening for every valid call
-- (a real proposal's base is always an ancestor of current), additive only in
-- that it now REJECTS the mismatched pairs the app never produces.
-- ============================================================

create or replace function public.canvas_apply_merged_edit(
  _edit_id                     uuid,
  _merged_html                 text,
  _merged_styles               text,
  _expected_current_version_id uuid
)
returns public.canvas_slide_version
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_edit     public.canvas_deck_edit;
  v_slide    public.canvas_deck_slide;
  v_new_no   int;
  v_new      public.canvas_slide_version;
  v_rowcount int;
  v_base_no  int;
  v_curr_no  int;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if v_edit.id is null
     or auth.uid() is null
     or not public.canvas_can_edit_deck(v_edit.deck_id) then
    raise exception 'canvas_apply_merged_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_apply_merged_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  -- Only slide-content proposals carry mergeable text.
  if v_edit.kind <> 'slide_edit' or v_edit.slide_id is null then
    raise exception 'canvas_apply_merged_edit: only slide_edit proposals can be merged (kind=%)', v_edit.kind;
  end if;

  -- Same self-approval guard as canvas_apply_edit. No revert carve-out: a merge
  -- is never a revert of one's own resolved edit.
  if v_edit.proposed_by = auth.uid()
     and not public.is_workspace_admin_or_owner(v_edit.workspace_id)
     and not public.canvas_workspace_allows_self_approval(v_edit.workspace_id) then
    raise exception 'canvas_apply_merged_edit: only workspace admins can approve their own proposal';
  end if;

  select * into v_slide from public.canvas_deck_slide where id = v_edit.slide_id;
  if not found then
    raise exception 'canvas_apply_merged_edit: slide % not found', v_edit.slide_id;
  end if;

  -- Optimistic concurrency: the merge was computed against THIS current version.
  -- If the slide advanced again since, the merged content is stale — refuse so a
  -- merge built on an outdated base can never overwrite even newer work.
  if v_slide.current_version_id is distinct from _expected_current_version_id then
    raise exception 'canvas_apply_merged_edit: merge_base_moved (slide advanced since the merge was computed)';
  end if;

  -- Defense-in-depth on the merge's DECLARED base. A sound merge's base must be a
  -- version of THIS slide at or before the current version it was merged onto
  -- (linear per-slide history → same slide AND base.version_no <= current). This
  -- rejects a mismatched (base, current) pair — a base from another slide, or one
  -- that postdates current — that the app never produces but a future caller or a
  -- pairing bug could. Skipped for legacy proposals with no recorded base.
  if v_edit.base_version_id is not null then
    select version_no into v_base_no
      from public.canvas_slide_version
     where id = v_edit.base_version_id and slide_id = v_slide.id;
    if v_base_no is null then
      raise exception 'canvas_apply_merged_edit: merge_base_invalid (proposal base % is not a version of slide %)',
        v_edit.base_version_id, v_slide.id;
    end if;

    select version_no into v_curr_no
      from public.canvas_slide_version
     where id = _expected_current_version_id and slide_id = v_slide.id;
    if v_curr_no is null or v_base_no > v_curr_no then
      raise exception 'canvas_apply_merged_edit: merge_base_invalid (base v% is not an ancestor of current v%)',
        v_base_no, v_curr_no;
    end if;
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
    coalesce(v_edit.new_slide_payload->>'title', v_slide.title),
    _merged_html,
    _merged_styles,
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
    raise exception 'canvas_apply_merged_edit: slide update touched no rows for slide %', v_slide.id;
  end if;

  update public.canvas_deck_edit
    set status = 'applied', resolved_at = now(), resolved_by = auth.uid()
    where id = v_edit.id;

  return v_new;
end;
$$;

revoke execute on function public.canvas_apply_merged_edit(uuid, text, text, uuid) from public, anon;
grant  execute on function public.canvas_apply_merged_edit(uuid, text, text, uuid) to authenticated;
