-- ============================================================
-- Performance: covering indexes for foreign keys (migration 0016)
-- ============================================================
-- The Supabase performance advisor flags 12 foreign keys with no covering
-- index. Without one, FK constraint checks and cascade deletes on the parent
-- do a sequential scan of the child, and joins/filters on the owner columns
-- (author_id, created_by, locked_by, …) can't use an index. These are all
-- low-cardinality ownership/attribution columns that the app filters and joins
-- on (e.g. "my proposals", "who locked this slide"). Additive and reversible.
-- ============================================================

create index if not exists canvas_comment_author_id_idx on public.canvas_comment (author_id);
create index if not exists canvas_comment_resolved_by_idx on public.canvas_comment (resolved_by);
create index if not exists canvas_deck_created_by_idx on public.canvas_deck (created_by);
create index if not exists canvas_deck_edit_resolved_by_idx on public.canvas_deck_edit (resolved_by);
create index if not exists canvas_deck_member_invited_by_idx on public.canvas_deck_member (invited_by);
create index if not exists canvas_deck_slide_created_by_idx on public.canvas_deck_slide (created_by);
create index if not exists canvas_deck_slide_lock_locked_by_idx on public.canvas_deck_slide_lock (locked_by);
create index if not exists canvas_deck_snapshot_created_by_idx on public.canvas_deck_snapshot (created_by);
create index if not exists canvas_deck_source_created_by_idx on public.canvas_deck_source (created_by);
create index if not exists canvas_edit_comment_author_id_idx on public.canvas_edit_comment (author_id);
create index if not exists canvas_slide_version_created_by_idx on public.canvas_slide_version (created_by);
create index if not exists workspace_invites_invited_by_idx on public.workspace_invites (invited_by);
