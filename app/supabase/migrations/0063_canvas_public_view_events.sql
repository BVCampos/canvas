-- ============================================================
-- 0063 — share-link analytics (v0): recipient-facing view events.
--
-- The public deck viewer (/p/{token}) starts reporting anonymous view
-- telemetry (opens + per-slide dwell) through the existing
-- canvas_usage_event spine. Those rows are written by the server-side
-- logger (service role) like every other usage event; the only schema
-- change needed is a new 'public' surface so recipient telemetry never
-- pollutes the adoption dashboard's 'api' bucket and stays filterable.
--
-- Volume note: public views can dwarf internal authoring events. The
-- partial index below serves the per-deck engagement report; if the
-- table grows past the ~1M-row mark called out in 0014, the
-- surface='public' slice is the first candidate to prune/partition.
-- ============================================================

alter table public.canvas_usage_event
  drop constraint canvas_usage_event_surface_check;

alter table public.canvas_usage_event
  add constraint canvas_usage_event_surface_check
  check (surface in ('mcp', 'api', 'action', 'auth', 'public'));

-- Engagement report read path: all public events for one deck, time-ordered.
create index if not exists canvas_usage_event_public_deck_idx
  on public.canvas_usage_event (deck_id, created_at)
  where surface = 'public';
