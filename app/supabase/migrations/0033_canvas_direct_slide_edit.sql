-- ============================================================
-- Direct (non-proposal) human slide-HTML editing — migration 0033
-- ============================================================
-- Until now the ONLY path that wrote canvas_deck_slide.html_body was
-- canvas_apply_edit (approving a proposal). This adds a parallel, still-
-- versioned path for a human editing a slide's HTML directly in the Canvas UI
-- (the inline "Edit text" surface + the raw-HTML code view), bypassing the
-- propose -> approve loop while preserving the exact same version history.
--
-- Modeled on canvas_restore_slide_version (migration 0030): insert a new
-- canvas_slide_version row (author_kind='user', created_by=auth.uid(),
-- source_edit_id NULL because there is no proposal behind it) and update the
-- slide's denormalized cache. SECURITY INVOKER — the existing
-- canvas_deck_slide UPDATE RLS policy ("slide owners and admins update
-- slides") is the authoritative gate on who may save, exactly like the
-- approve path. A caller without UPDATE rights makes the cache update touch
-- zero rows, which the row-count guard turns into an aborting error rather
-- than a phantom success (and rolls back the version insert with it).
--
-- Optimistic-concurrency guard: the caller passes the current_version_id it
-- edited against (_base_version_id). If the slide has moved on since (someone
-- approved an edit, restored a version, or saved their own direct edit), we
-- abort so this save can't silently clobber the newer content. The message
-- carries the stable token `stale_base_version` so the app layer can show a
-- "refresh and re-apply" hint instead of a raw error. Pass NULL to skip.
-- ============================================================

create or replace function public.canvas_save_slide_direct(
  _slide_id uuid,
  _new_html text,
  _base_version_id uuid default null,
  _summary text default null
)
returns public.canvas_slide_version
language plpgsql
set search_path = public
as $$
declare
  v_slide    public.canvas_deck_slide;
  v_new_no   int;
  v_new      public.canvas_slide_version;
  v_rowcount int;
begin
  select * into v_slide from public.canvas_deck_slide where id = _slide_id;
  if not found then
    raise exception 'canvas_save_slide_direct: slide % not found or not accessible', _slide_id;
  end if;

  if _new_html is null or length(trim(_new_html)) = 0 then
    raise exception 'canvas_save_slide_direct: new_html cannot be empty';
  end if;

  -- Optimistic concurrency: bail if the slide changed under the editor.
  if _base_version_id is not null
     and v_slide.current_version_id is distinct from _base_version_id then
    raise exception 'canvas_save_slide_direct: stale_base_version — slide % changed since editing started', _slide_id;
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
    v_slide.title, _new_html, v_slide.slide_styles,
    'user',
    auth.uid(),
    coalesce(nullif(trim(_summary), ''), 'Direct edit')
  )
  returning * into v_new;

  update public.canvas_deck_slide
    set html_body          = v_new.html_body,
        current_version_id = v_new.id
    where id = v_slide.id;

  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    raise exception 'canvas_save_slide_direct: slide update touched no rows for slide % — you may not have permission to edit it', v_slide.id;
  end if;

  return v_new;
end;
$$;

revoke execute on function public.canvas_save_slide_direct(uuid, text, uuid, text) from public, anon;
grant  execute on function public.canvas_save_slide_direct(uuid, text, uuid, text) to authenticated;
