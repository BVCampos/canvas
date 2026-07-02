-- ============================================================
-- Proposal lifecycle notifications — routing + delivery
-- ============================================================
-- Delivery lives beside the state transition so proposals created by the web,
-- any MCP agent, or future clients all behave identically.

create or replace function public.canvas_notify_proposal_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
  v_preview text;
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    -- Prefer the person explicitly responsible for this slide.
    if new.slide_id is not null then
      select s.owner_id into v_recipient
      from public.canvas_deck_slide s
      join public.workspace_memberships wm
        on wm.workspace_id = new.workspace_id
       and wm.user_id = s.owner_id
      where s.id = new.slide_id
        and s.owner_id is distinct from new.proposed_by;
    end if;

    -- Otherwise route to the deck creator when they are still a member.
    if v_recipient is null then
      select d.created_by into v_recipient
      from public.canvas_deck d
      join public.workspace_memberships wm
        on wm.workspace_id = new.workspace_id
       and wm.user_id = d.created_by
      where d.id = new.deck_id
        and d.created_by is distinct from new.proposed_by;
    end if;

    -- Last resort: the longest-standing owner/admin other than the proposer.
    if v_recipient is null then
      select wm.user_id into v_recipient
      from public.workspace_memberships wm
      where wm.workspace_id = new.workspace_id
        and wm.role in ('owner', 'admin')
        and wm.user_id is distinct from new.proposed_by
      order by wm.joined_at asc, wm.user_id asc
      limit 1;
    end if;

    if v_recipient is not null then
      v_preview := nullif(
        left(regexp_replace(coalesce(new.rationale, ''), '\s+', ' ', 'g'), 140),
        ''
      );
      insert into public.canvas_notification (
        workspace_id, user_id, actor_id, kind, deck_id, slide_id, edit_id,
        body_preview
      ) values (
        new.workspace_id, v_recipient, new.proposed_by, 'proposal_waiting',
        new.deck_id, new.slide_id, new.id,
        coalesce(v_preview, 'A proposal is waiting for review.')
      ) on conflict do nothing;
    end if;

    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'pending'
     and new.status in ('applied', 'rejected')
     and new.resolved_by is distinct from new.proposed_by then
    insert into public.canvas_notification (
      workspace_id, user_id, actor_id, kind, deck_id, slide_id, edit_id,
      body_preview
    ) values (
      new.workspace_id,
      new.proposed_by,
      new.resolved_by,
      case new.status
        when 'applied' then 'proposal_applied'::public.canvas_notification_kind
        else 'proposal_rejected'::public.canvas_notification_kind
      end,
      new.deck_id,
      new.slide_id,
      new.id,
      case new.status
        when 'applied' then 'Your proposal was applied.'
        else 'Your proposal was rejected.'
      end
    ) on conflict do nothing;
  end if;

  return new;
end;
$$;

revoke execute on function public.canvas_notify_proposal_lifecycle()
  from public, anon, authenticated;

drop trigger if exists canvas_deck_edit_notify_lifecycle_trg
  on public.canvas_deck_edit;
create trigger canvas_deck_edit_notify_lifecycle_trg
  after insert or update of status on public.canvas_deck_edit
  for each row execute function public.canvas_notify_proposal_lifecycle();

comment on function public.canvas_notify_proposal_lifecycle() is
  'Routes new proposals to one reviewer and reports applied/rejected outcomes to the proposer.';

