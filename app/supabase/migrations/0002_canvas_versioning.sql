-- ============================================================
-- Canvas versioning — migration 0002
-- ============================================================
-- Adds per-slide immutable version history + named deck snapshots.
--
-- Model:
--   - Every applied edit creates an append-only row in canvas_slide_version.
--   - canvas_deck_slide keeps a denormalized fast-read cache (html_body, etc.)
--     plus current_version_id pointing at the latest version row.
--   - canvas_deck_snapshot is a frozen pointer set (theme + nav + position →
--     slide_version_id map). Cheap to create.
--   - Restores are NEVER destructive: they create new version rows containing
--     the restored content. History stays linear forever.
--   - Linear parent_version_id is in place; DAG/branching can layer on later
--     without a schema change.
--
-- Auto-snapshot kinds:
--   manual           — user-initiated, with a label
--   pre_export       — captured before an HTML download / share link
--   pre_share        — captured on "Mark as sent to client"
--   pre_consolidate  — captured before a multi-slide AI rewrite
--   pre_restore      — captured before a restore-from-snapshot
--   daily            — cron, taken at 00:00 if anything changed that day
--
-- Retention (deferred to a future cron migration): `daily` auto-snapshots
-- older than 90 days may be pruned. All other kinds stay forever.
-- ============================================================

-- ============================================================
-- canvas_slide_version — immutable, append-only
-- ============================================================

create table public.canvas_slide_version (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  deck_id             uuid not null references public.canvas_deck(id) on delete cascade,
  slide_id            uuid not null references public.canvas_deck_slide(id) on delete cascade,
  version_no          int  not null,
  parent_version_id   uuid references public.canvas_slide_version(id) on delete set null,

  title               text not null default '',
  html_body           text not null default '',
  slide_styles        text not null default '',

  -- attribution
  author_kind         text not null default 'user' check (author_kind in ('user', 'claude')),
  created_by          uuid references public.users(id) on delete set null,
  source_prompt       text,
  source_edit_id      uuid references public.canvas_deck_edit(id) on delete set null,

  created_at          timestamptz not null default now()
);

alter table public.canvas_slide_version
  add constraint canvas_slide_version_no_uq
  unique (slide_id, version_no) deferrable initially deferred;

create index canvas_slide_version_slide_idx        on public.canvas_slide_version(slide_id, version_no desc);
create index canvas_slide_version_deck_idx         on public.canvas_slide_version(deck_id, created_at desc);
create index canvas_slide_version_workspace_idx    on public.canvas_slide_version(workspace_id);
create index canvas_slide_version_parent_idx       on public.canvas_slide_version(parent_version_id) where parent_version_id is not null;
create index canvas_slide_version_edit_idx         on public.canvas_slide_version(source_edit_id) where source_edit_id is not null;

-- ============================================================
-- canvas_deck_slide — add current_version_id pointer
-- ============================================================

alter table public.canvas_deck_slide
  add column current_version_id uuid references public.canvas_slide_version(id) on delete set null;

create index canvas_deck_slide_current_version_idx on public.canvas_deck_slide(current_version_id) where current_version_id is not null;

-- ============================================================
-- canvas_deck_snapshot — named cuts of the whole deck
-- ============================================================

create type public.canvas_snapshot_kind as enum (
  'manual', 'pre_export', 'pre_share', 'pre_consolidate', 'pre_restore', 'daily'
);

create table public.canvas_deck_snapshot (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  deck_id       uuid not null references public.canvas_deck(id) on delete cascade,
  label         text not null,
  description   text,
  theme_css     text not null default '',
  nav_js        text not null default '',
  meta          jsonb not null default '{}'::jsonb,
  kind          public.canvas_snapshot_kind not null default 'manual',
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
  -- intentionally no updated_at: snapshots are immutable
);

create index canvas_deck_snapshot_deck_idx       on public.canvas_deck_snapshot(deck_id, created_at desc);
create index canvas_deck_snapshot_workspace_idx  on public.canvas_deck_snapshot(workspace_id);
create index canvas_deck_snapshot_kind_idx       on public.canvas_deck_snapshot(deck_id, kind, created_at desc);

create table public.canvas_deck_snapshot_slide (
  snapshot_id        uuid not null references public.canvas_deck_snapshot(id) on delete cascade,
  slide_version_id   uuid not null references public.canvas_slide_version(id) on delete cascade,
  position           int  not null,
  primary key (snapshot_id, position)
);

create index canvas_deck_snapshot_slide_version_idx on public.canvas_deck_snapshot_slide(slide_version_id);

-- ============================================================
-- Enable RLS on new tables
-- ============================================================

alter table public.canvas_slide_version       enable row level security;
alter table public.canvas_deck_snapshot       enable row level security;
alter table public.canvas_deck_snapshot_slide enable row level security;

-- ============================================================
-- Policies — canvas_slide_version (immutable)
-- ============================================================

create policy "members read slide versions"
  on public.canvas_slide_version for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members insert slide versions"
  on public.canvas_slide_version for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

-- No UPDATE, no DELETE policies. Versions are append-only.
-- ON DELETE CASCADE on the deck/slide handles cleanup of orphaned rows
-- when a deck is removed.

-- ============================================================
-- Policies — canvas_deck_snapshot (immutable except admin delete)
-- ============================================================

create policy "members read snapshots"
  on public.canvas_deck_snapshot for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members create snapshots"
  on public.canvas_deck_snapshot for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

create policy "admins delete snapshots"
  on public.canvas_deck_snapshot for delete
  to authenticated
  using (public.is_workspace_admin_or_owner(workspace_id));

-- No UPDATE policy: snapshots are immutable.

-- ============================================================
-- Policies — canvas_deck_snapshot_slide
-- Visibility/write follows the parent snapshot.
-- ============================================================

create policy "members read snapshot slides"
  on public.canvas_deck_snapshot_slide for select
  to authenticated
  using (
    exists (
      select 1 from public.canvas_deck_snapshot s
      where s.id = snapshot_id
        and public.is_workspace_member(s.workspace_id)
    )
  );

create policy "members create snapshot slides"
  on public.canvas_deck_snapshot_slide for insert
  to authenticated
  with check (
    exists (
      select 1 from public.canvas_deck_snapshot s
      where s.id = snapshot_id
        and public.is_workspace_member(s.workspace_id)
    )
  );

-- No UPDATE; DELETE cascades from snapshot.

-- ============================================================
-- Auto-create v1 on slide insert
-- ============================================================
-- Every new slide automatically gets a version_no=1 row, and the slide's
-- current_version_id is pointed at it. Single source of truth from day one.

create or replace function public.canvas_deck_slide_init_version()
returns trigger
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into public.canvas_slide_version (
    workspace_id, deck_id, slide_id, version_no, parent_version_id,
    title, html_body, slide_styles,
    author_kind, created_by, source_prompt
  )
  values (
    new.workspace_id, new.deck_id, new.id, 1, null,
    new.title, new.html_body, new.slide_styles,
    'user',
    coalesce(new.created_by, auth.uid()),
    new.source_prompt
  )
  returning id into v_id;

  update public.canvas_deck_slide
    set current_version_id = v_id
    where id = new.id;

  return null;
end;
$$;

create trigger canvas_deck_slide_init_version_trg
  after insert on public.canvas_deck_slide
  for each row execute function public.canvas_deck_slide_init_version();

-- ============================================================
-- RPC: canvas_apply_edit(edit_id)
-- ============================================================
-- Atomically:
--   1. Insert new canvas_slide_version (or update theme_css/nav_js on deck for theme/nav kinds)
--   2. Update canvas_deck_slide denorm + current_version_id (for slide kinds)
--   3. Mark canvas_deck_edit applied
--
-- SECURITY INVOKER (default): all internal queries go through RLS as the
-- caller. Members can read their workspace; the RLS policy on canvas_deck_slide
-- ("slide owners and admins update") enforces who can actually apply.
-- ============================================================

create or replace function public.canvas_apply_edit(_edit_id uuid)
returns public.canvas_slide_version
language plpgsql
as $$
declare
  v_edit       public.canvas_deck_edit;
  v_slide      public.canvas_deck_slide;
  v_deck       public.canvas_deck;
  v_new_no     int;
  v_new        public.canvas_slide_version;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found then
    raise exception 'canvas_apply_edit: edit % not found or not accessible', _edit_id;
  end if;

  if v_edit.status <> 'pending' then
    raise exception 'canvas_apply_edit: edit % is not pending (status=%)', _edit_id, v_edit.status;
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

-- ============================================================
-- RPC: canvas_restore_slide_version(slide_id, to_version_id)
-- ============================================================
-- Restores a slide to a prior version by CREATING A NEW VERSION whose content
-- matches the target. Never overwrites history.
-- ============================================================

create or replace function public.canvas_restore_slide_version(_slide_id uuid, _to_version_id uuid)
returns public.canvas_slide_version
language plpgsql
as $$
declare
  v_slide   public.canvas_deck_slide;
  v_source  public.canvas_slide_version;
  v_new_no  int;
  v_new     public.canvas_slide_version;
begin
  select * into v_slide from public.canvas_deck_slide where id = _slide_id;
  if not found then
    raise exception 'canvas_restore_slide_version: slide % not found', _slide_id;
  end if;

  select * into v_source from public.canvas_slide_version where id = _to_version_id;
  if not found then
    raise exception 'canvas_restore_slide_version: source version % not found', _to_version_id;
  end if;

  if v_source.slide_id <> v_slide.id then
    raise exception 'canvas_restore_slide_version: source version belongs to a different slide';
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
    v_source.title, v_source.html_body, v_source.slide_styles,
    'user',
    auth.uid(),
    format('restored from v%s', v_source.version_no)
  )
  returning * into v_new;

  update public.canvas_deck_slide
    set title              = v_new.title,
        html_body          = v_new.html_body,
        slide_styles       = v_new.slide_styles,
        current_version_id = v_new.id
    where id = v_slide.id;

  return v_new;
end;
$$;

-- ============================================================
-- RPC: canvas_create_snapshot(deck_id, label, description, kind)
-- ============================================================
-- Captures the current state of every slide on the deck plus the current
-- theme/nav. Cheap: just pointer references, no content duplication beyond
-- theme_css/nav_js which live on the snapshot row itself.
-- ============================================================

create or replace function public.canvas_create_snapshot(
  _deck_id      uuid,
  _label        text,
  _description  text default null,
  _kind         public.canvas_snapshot_kind default 'manual'
)
returns public.canvas_deck_snapshot
language plpgsql
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

  insert into public.canvas_deck_snapshot_slide (snapshot_id, slide_version_id, position)
  select v_snapshot.id, s.current_version_id, s.position
    from public.canvas_deck_slide s
   where s.deck_id = v_deck.id
     and s.current_version_id is not null
   order by s.position;

  return v_snapshot;
end;
$$;

-- ============================================================
-- RPC: canvas_restore_snapshot(snapshot_id)
-- ============================================================
-- Restores theme/nav on the deck and, for each (position, slide_version_id)
-- captured in the snapshot, creates a NEW version on the matching slide that
-- copies content from the snapshotted version. Always auto-creates a
-- pre_restore snapshot first so the user can undo.
--
-- If a slide has been deleted since the snapshot, that entry is skipped.
-- (Recreating deleted slides is deferred — flag as a UI warning.)
-- ============================================================

create or replace function public.canvas_restore_snapshot(_snapshot_id uuid)
returns int
language plpgsql
as $$
declare
  v_snapshot   public.canvas_deck_snapshot;
  v_count      int := 0;
  r            record;
  v_source     public.canvas_slide_version;
  v_new_no     int;
  v_new_id     uuid;
begin
  select * into v_snapshot from public.canvas_deck_snapshot where id = _snapshot_id;
  if not found then
    raise exception 'canvas_restore_snapshot: snapshot % not found', _snapshot_id;
  end if;

  -- Safety net: snapshot the current state before restoring.
  perform public.canvas_create_snapshot(
    v_snapshot.deck_id,
    format('Pre-restore safety net (was about to restore "%s")', v_snapshot.label),
    null,
    'pre_restore'
  );

  -- Restore deck-level theme + nav.
  update public.canvas_deck
    set theme_css = v_snapshot.theme_css,
        nav_js    = v_snapshot.nav_js
    where id = v_snapshot.deck_id;

  -- For each captured slide_version, create a new version on the live slide.
  for r in (
    select ss.slide_version_id, ss.position
      from public.canvas_deck_snapshot_slide ss
     where ss.snapshot_id = _snapshot_id
     order by ss.position
  ) loop
    select * into v_source from public.canvas_slide_version where id = r.slide_version_id;
    if not found then continue; end if;

    -- Slide must still exist; if it's been deleted, skip silently for v0.
    if not exists (select 1 from public.canvas_deck_slide where id = v_source.slide_id) then
      continue;
    end if;

    select coalesce(max(version_no), 0) + 1
      into v_new_no
      from public.canvas_slide_version
     where slide_id = v_source.slide_id;

    insert into public.canvas_slide_version (
      workspace_id, deck_id, slide_id, version_no, parent_version_id,
      title, html_body, slide_styles,
      author_kind, created_by, source_prompt
    )
    select s.workspace_id, s.deck_id, s.id, v_new_no, s.current_version_id,
           v_source.title, v_source.html_body, v_source.slide_styles,
           'user', auth.uid(),
           format('restored from snapshot %L', v_snapshot.label)
      from public.canvas_deck_slide s
     where s.id = v_source.slide_id
    returning id into v_new_id;

    update public.canvas_deck_slide
      set title              = v_source.title,
          html_body          = v_source.html_body,
          slide_styles       = v_source.slide_styles,
          current_version_id = v_new_id
      where id = v_source.slide_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ============================================================
-- Grants for RPC functions
-- ============================================================

grant execute on function public.canvas_apply_edit(uuid)                              to authenticated;
grant execute on function public.canvas_restore_slide_version(uuid, uuid)             to authenticated;
grant execute on function public.canvas_create_snapshot(uuid, text, text, public.canvas_snapshot_kind) to authenticated;
grant execute on function public.canvas_restore_snapshot(uuid)                        to authenticated;
