-- ============================================================
-- 0067 — speaker notes (present-mode v0).
--
-- One text column on the slide, written DIRECT (no proposal): notes are
-- presenter working text, not the visual deliverable — a reviewer gains
-- nothing from approving a talk track, and ADR-0012's litmus (additive /
-- non-clobbering / low-stakes → direct) applies. Deliberately NOT
-- versioned: threading a field through canvas_apply_edit + the restore
-- RPCs is exactly the high-blast-radius change the improvement map defers;
-- last-write-wins like the slide title. Deck-shared (one talk track), not
-- per-presenter.
-- ============================================================

alter table public.canvas_deck_slide
  add column speaker_notes text;

comment on column public.canvas_deck_slide.speaker_notes is
  'Presenter talk track for this slide. Deck-shared, NOT versioned — see ADR-0012 for the direct-vs-propose litmus. Two write paths: the MCP write_slide_notes tool updates this column directly under its own edit gate (the service-role context has auth.uid() = null, so it cannot call the RPC), while canvas_save_slide_notes_direct serves future in-app (user-session) writers.';

-- Mirrors canvas_save_slide_direct's shape (0033/0061): SECURITY DEFINER
-- with canvas_can_edit_deck as the single explicit gate.
create or replace function public.canvas_save_slide_notes_direct(
  _slide_id uuid,
  _notes text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slide public.canvas_deck_slide;
begin
  if auth.uid() is null then
    raise exception 'canvas_save_slide_notes_direct: not authenticated';
  end if;

  select * into v_slide from public.canvas_deck_slide where id = _slide_id;
  if not found then
    raise exception 'canvas_save_slide_notes_direct: slide % not found', _slide_id;
  end if;

  if not public.canvas_can_edit_deck(v_slide.deck_id) then
    raise exception 'canvas_save_slide_notes_direct: not_authorized — you cannot edit deck %', v_slide.deck_id;
  end if;

  update public.canvas_deck_slide
     set speaker_notes = nullif(trim(coalesce(_notes, '')), '')
   where id = _slide_id;
end;
$$;

revoke execute on function public.canvas_save_slide_notes_direct(uuid, text) from public, anon;
grant  execute on function public.canvas_save_slide_notes_direct(uuid, text) to authenticated;
