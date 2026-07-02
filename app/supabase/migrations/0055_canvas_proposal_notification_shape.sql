-- ============================================================
-- Proposal lifecycle notifications — schema
-- ============================================================
-- Keep the enum change in its own migration: PostgreSQL only permits newly
-- added enum values to be used after the transaction that added them commits.

alter type public.canvas_notification_kind
  add value if not exists 'proposal_waiting';
alter type public.canvas_notification_kind
  add value if not exists 'proposal_applied';
alter type public.canvas_notification_kind
  add value if not exists 'proposal_rejected';

alter table public.canvas_notification
  add column if not exists edit_id uuid
    references public.canvas_deck_edit(id) on delete cascade;

create index if not exists canvas_notification_edit_idx
  on public.canvas_notification (edit_id)
  where edit_id is not null;

-- A trigger may observe the same transition again during retries. One user
-- receives at most one notification for each proposal lifecycle stage.
create unique index if not exists canvas_notification_proposal_stage_uq
  on public.canvas_notification (user_id, kind, edit_id)
  where edit_id is not null;

comment on column public.canvas_notification.edit_id is
  'Proposal linked to a waiting/applied/rejected lifecycle notification.';

