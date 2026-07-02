-- ============================================================
-- Self-contained snapshots + restore reconstructs deleted slides — migration 0061
-- ============================================================
-- Bug: restoring a snapshot taken BEFORE a slide was deleted did NOT bring the
-- slide back. Two compounding causes, the second of which silently destroyed the
-- data so even a "correct" restore had nothing to copy:
--
--   1. canvas_restore_snapshot SKIPPED any slide that no longer existed
--      (the `if not exists (...) then continue` guard in migration 0030). It
--      only ever advanced slides that were still present, never re-created a
--      deleted one. Recreating deleted slides was explicitly deferred in the
--      0002 header ("Recreating deleted slides is deferred — flag as a UI
--      warning.").
--
--   2. Worse, a snapshot never stored slide CONTENT — only a POINTER. Each
--      canvas_deck_snapshot_slide row held (slide_version_id, position), and
--      slide_version_id referenced canvas_slide_version ON DELETE CASCADE.
--      Deleting a slide is a hard delete (canvas_apply_edit slide_delete) that
--      cascades canvas_slide_version.slide_id -> canvas_deck_slide, which in
--      turn cascades canvas_deck_snapshot_slide.slide_version_id. So approving a
--      delete reached BACK IN TIME and hollowed out every pre-deletion snapshot:
--      the captured row for that slide vanished. Restore then had no row to even
--      iterate over, and no content to copy if it had.
--
-- Fix — make a snapshot an immutable, self-contained copy, and teach restore to
-- rebuild membership:
--
--   A. Denormalize title/html_body/slide_styles + the originating slide_id INTO
--      canvas_deck_snapshot_slide at capture time. The version pointer stays as
--      a fast path while the version survives, but content no longer depends on
--      it.
--   B. Break the cascade: slide_version_id becomes nullable + ON DELETE SET
--      NULL. Deleting a slide now only NULLs the dangling pointer; the snapshot
--      row (and its content) survives.
--   C. canvas_create_snapshot writes the denormalized copy.
--   D. canvas_restore_snapshot reconstructs any snapshot slide whose target no
--      longer exists, re-inserting it at its captured position (re-opening the
--      slot exactly like canvas_apply_edit's slide_create), and otherwise keeps
--      the existing forward-only behaviour (append a new version, advance the
--      denorm cache). It prefers the surviving version row for content and falls
--      back to the denormalized copy, so legacy rows captured before this
--      migration still restore correctly.
--
-- Scope note: restore still does not REMOVE slides added after the snapshot, nor
-- re-order slides that merely moved — it restores content, theme/nav, and now
-- deleted-slide membership. Reconstruction reuses the original slide id so a
-- re-run is idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- A + B. Schema: denormalize content, keep the snapshot row alive past a delete
-- ------------------------------------------------------------
alter table public.canvas_deck_snapshot_slide
  add column if not exists slide_id     uuid,
  add column if not exists title        text not null default '',
  add column if not exists html_body    text not null default '',
  add column if not exists slide_styles text not null default '';

-- The version pointer must no longer be load-bearing: a snapshot row outlives
-- the slide it captured.
alter table public.canvas_deck_snapshot_slide
  alter column slide_version_id drop not null;

alter table public.canvas_deck_snapshot_slide
  drop constraint if exists canvas_deck_snapshot_slide_slide_version_id_fkey;

alter table public.canvas_deck_snapshot_slide
  add constraint canvas_deck_snapshot_slide_slide_version_id_fkey
  foreign key (slide_version_id)
  references public.canvas_slide_version(id) on delete set null;

-- Backfill existing snapshots from their still-surviving version rows so older
-- snapshots become self-contained too. (Rows whose version was already cascaded
-- away no longer exist — that data is unrecoverable here — but every surviving
-- row is made whole, and nothing can hollow them out again.)
update public.canvas_deck_snapshot_slide ss
   set slide_id     = sv.slide_id,
       title        = sv.title,
       html_body    = sv.html_body,
       slide_styles = sv.slide_styles
  from public.canvas_slide_version sv
 where ss.slide_version_id = sv.id
   and ss.slide_id is null;

-- ------------------------------------------------------------
-- C. canvas_create_snapshot — capture the denormalized copy
-- ------------------------------------------------------------
create or replace function public.canvas_create_snapshot(
  _deck_id      uuid,
  _label        text,
  _description  text default null,
  _kind         public.canvas_snapshot_kind default 'manual'
)
returns public.canvas_deck_snapshot
language plpgsql
set search_path = public
as $$
declare
  v_deck     public.canvas_deck;
  v_snapshot public.canvas_deck_snapshot;
begin
  select * into v_deck from public.canvas_deck where id = _deck_id;
  if not found then
    raise exception 'canvas_create_snapshot: deck % not found', _deck_id;
  end if;

  insert into public.canvas_deck_snapshot (
    workspace_id, deck_id, label, description, theme_css, nav_js, meta, kind, created_by
  )
  values (
    v_deck.workspace_id, v_deck.id, _label, _description,
    v_deck.theme_css, v_deck.nav_js, v_deck.meta, _kind, auth.uid()
  )
  returning * into v_snapshot;

  -- Each captured slide is SELF-CONTAINED: the version pointer (fast path while
  -- the version survives) plus a denormalized copy of the content and the slide
  -- id, so a later hard-delete of the slide can no longer hollow this out.
  insert into public.canvas_deck_snapshot_slide (
    snapshot_id, slide_version_id, slide_id, position, title, html_body, slide_styles
  )
  select v_snapshot.id, s.current_version_id, s.id, s.position,
         sv.title, sv.html_body, sv.slide_styles
    from public.canvas_deck_slide s
    join public.canvas_slide_version sv on sv.id = s.current_version_id
   where s.deck_id = v_deck.id
     and s.current_version_id is not null
   order by s.position;

  return v_snapshot;
end;
$$;

-- ------------------------------------------------------------
-- D. canvas_restore_snapshot — reconstruct deleted slides
-- ------------------------------------------------------------
create or replace function public.canvas_restore_snapshot(_snapshot_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_snapshot public.canvas_deck_snapshot;
  v_count    int := 0;
  r          record;
  v_source   public.canvas_slide_version;
  v_have_ver boolean;
  v_title    text;
  v_html     text;
  v_styles   text;
  v_slide_id uuid;
  v_new_no   int;
  v_new_id   uuid;
  v_rowcount int;
begin
  select * into v_snapshot from public.canvas_deck_snapshot where id = _snapshot_id;
  if not found then
    raise exception 'canvas_restore_snapshot: snapshot % not found', _snapshot_id;
  end if;

  -- Safety net: snapshot the current state before restoring so the restore is
  -- itself undoable.
  perform public.canvas_create_snapshot(
    v_snapshot.deck_id,
    format('Pre-restore safety net (was about to restore "%s")', v_snapshot.label),
    null,
    'pre_restore'
  );

  update public.canvas_deck
    set theme_css = v_snapshot.theme_css,
        nav_js    = v_snapshot.nav_js
    where id = v_snapshot.deck_id;

  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    raise exception 'canvas_restore_snapshot: deck update touched no rows for deck %', v_snapshot.deck_id;
  end if;

  for r in (
    select ss.slide_version_id, ss.slide_id, ss.position,
           ss.title, ss.html_body, ss.slide_styles
      from public.canvas_deck_snapshot_slide ss
     where ss.snapshot_id = _snapshot_id
     order by ss.position
  ) loop
    -- Resolve content. Prefer the immutable version row while it survives (this
    -- covers legacy rows whose denormalized columns are still ''); fall back to
    -- the snapshot's own denormalized copy, which persists past a slide delete.
    v_source := null;
    if r.slide_version_id is not null then
      select * into v_source from public.canvas_slide_version where id = r.slide_version_id;
    end if;
    v_have_ver := v_source.id is not null;

    if v_have_ver then
      v_title    := v_source.title;
      v_html     := v_source.html_body;
      v_styles   := v_source.slide_styles;
      v_slide_id := coalesce(r.slide_id, v_source.slide_id);
    else
      v_title    := r.title;
      v_html     := r.html_body;
      v_styles   := r.slide_styles;
      v_slide_id := r.slide_id;
    end if;

    -- A legacy row captured before denormalization whose slide was already
    -- deleted has neither a surviving version nor a recorded identity. Nothing
    -- to restore; skip (the pre-0061 behaviour for these).
    if v_slide_id is null then
      continue;
    end if;

    if exists (select 1 from public.canvas_deck_slide where id = v_slide_id) then
      -- Slide still exists: forward-only restore. Append a new version copying
      -- the snapshot content, then advance the denorm cache.
      select coalesce(max(version_no), 0) + 1
        into v_new_no
        from public.canvas_slide_version
       where slide_id = v_slide_id;

      v_new_id := null;
      insert into public.canvas_slide_version (
        workspace_id, deck_id, slide_id, version_no, parent_version_id,
        title, html_body, slide_styles,
        author_kind, created_by, source_prompt
      )
      select s.workspace_id, s.deck_id, s.id, v_new_no, s.current_version_id,
             v_title, v_html, v_styles,
             'user', auth.uid(),
             format('restored from snapshot %L', v_snapshot.label)
        from public.canvas_deck_slide s
       where s.id = v_slide_id
      returning id into v_new_id;

      if v_new_id is null then
        raise exception 'canvas_restore_snapshot: version insert touched no rows for slide %', v_slide_id;
      end if;

      update public.canvas_deck_slide
        set title              = v_title,
            html_body          = v_html,
            slide_styles       = v_styles,
            current_version_id = v_new_id
        where id = v_slide_id;

      get diagnostics v_rowcount = row_count;
      if v_rowcount = 0 then
        raise exception 'canvas_restore_snapshot: slide update touched no rows for slide %', v_slide_id;
      end if;
    else
      -- Slide was deleted since the snapshot: RECONSTRUCT it at its captured
      -- position. Re-open the slot (shift later slides right by one), mirroring
      -- canvas_apply_edit's slide_create; this leans on the deferrable
      -- (deck_id, position) unique constraint from migration 0001. The
      -- canvas_deck_slide_init_version trigger writes v1 from the row's content.
      -- Reuse the original slide id so a re-run is idempotent and prior
      -- references resolve.
      update public.canvas_deck_slide
         set position = position + 1
       where deck_id = v_snapshot.deck_id
         and position >= r.position;

      insert into public.canvas_deck_slide (
        id, workspace_id, deck_id, position, title, html_body, slide_styles,
        owner_id, created_by, source_prompt
      )
      values (
        v_slide_id, v_snapshot.workspace_id, v_snapshot.deck_id, r.position,
        v_title, v_html, v_styles,
        null, auth.uid(),
        format('reconstructed from snapshot %L', v_snapshot.label)
      );
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- Re-apply grants. CREATE OR REPLACE resets default privileges to PUBLIC, so
-- re-tighten exactly as migrations 0008 / 0030 did.
-- ------------------------------------------------------------
revoke execute on function public.canvas_create_snapshot(uuid, text, text, public.canvas_snapshot_kind) from public, anon;
grant  execute on function public.canvas_create_snapshot(uuid, text, text, public.canvas_snapshot_kind) to authenticated;

revoke execute on function public.canvas_restore_snapshot(uuid) from public, anon;
grant  execute on function public.canvas_restore_snapshot(uuid) to authenticated;
