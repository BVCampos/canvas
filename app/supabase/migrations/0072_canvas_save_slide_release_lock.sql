-- ============================================================
-- Fold lock-release into the direct save — migration 0072
-- ============================================================
-- An inline save used to cost TWO serial server actions: saveSlideHtmlDirect
-- (the versioned write) then releaseSlide (delete the soft lock) — each its
-- own round-trip AND its own revalidatePath loader run (speed discovery
-- 2026-07 #5.4). The save RPC gains `_release_lock`: when true, the caller's
-- own lock on the slide is deleted in the same transaction as the save, so
-- the whole commit is one action, one revalidate, and the lock DELETE still
-- reaches other tabs through the existing canvas_deck_slide_lock realtime
-- publication.
--
-- The function stays SECURITY INVOKER (0033): the version insert, the slide
-- update, and the lock delete all run under the caller's RLS. The delete is
-- additionally holder-scoped (locked_by = auth.uid()) so a save can never
-- clear someone else's hold.
--
-- Adding a defaulted parameter changes the signature; CREATE OR REPLACE would
-- create an ambiguous OVERLOAD next to the 4-arg original (PostgREST refuses
-- ambiguous rpc calls), so the old function is dropped first. Callers pass
-- named arguments, so omitting _release_lock keeps today's behavior.

drop function if exists public.canvas_save_slide_direct(uuid, text, uuid, text);

create or replace function public.canvas_save_slide_direct(
  _slide_id uuid,
  _new_html text,
  _base_version_id uuid default null,
  _summary text default null,
  _release_lock boolean default false
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

  -- Same-transaction lock release (holder-scoped). A failure here would roll
  -- back the save too, which is correct: the caller asked for save+release as
  -- one commit.
  if _release_lock then
    delete from public.canvas_deck_slide_lock
     where slide_id = v_slide.id
       and locked_by = auth.uid();
  end if;

  return v_new;
end;
$$;

revoke execute on function public.canvas_save_slide_direct(uuid, text, uuid, text, boolean) from public, anon;
grant  execute on function public.canvas_save_slide_direct(uuid, text, uuid, text, boolean) to authenticated;
