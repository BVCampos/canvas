-- ============================================================
-- Apply a REBASED (3-way merged) slide_edit proposal — migration 0050
-- ============================================================
-- When a slide_edit proposal is approved after the slide moved on, "approve
-- anyway" today CLOBBERS the newer edits (documented content-loss bug). The app
-- instead computes a 3-way merge (lib/canvas/three-way-merge, node-diff3): apply
-- the proposal's changes (base -> theirs) on top of CURRENT. When that merge is
-- clean, this function commits the merged content atomically with the SAME
-- authority + self-approval guard as canvas_apply_edit, plus an extra optimistic
-- concurrency check: the merge was computed against a specific current version,
-- so we refuse if the slide advanced again since (the merge would be stale).
--
-- The merge itself runs in the app (node-diff3); this function only applies the
-- precomputed result, so it stays a thin, auditable mirror of the slide_edit
-- branch of canvas_apply_edit. On a conflict the app never calls this — it falls
-- back to the explicit refuse/clobber path.
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
