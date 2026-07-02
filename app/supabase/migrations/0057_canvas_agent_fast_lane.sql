-- ============================================================
-- Trusted agent fast lane
-- ============================================================
-- This is deliberately narrower than blanket self-approval. The workspace
-- must allow self-approval, the deck creator/admin must opt the deck in, and
-- the proposal must come from a deterministic patch path. The agent still
-- proposes and renders first; it explicitly applies only after visual review.

alter table public.canvas_deck
  add column if not exists agent_fast_lane_enabled boolean not null default false;

alter table public.canvas_deck_edit
  add column if not exists auto_apply_eligible boolean not null default false,
  add column if not exists agent_rendered_at timestamptz;

comment on column public.canvas_deck.agent_fast_lane_enabled is
  'Allows an owner''s eligible agent-authored patch proposals to be self-applied after render verification.';
comment on column public.canvas_deck_edit.auto_apply_eligible is
  'True only for deterministic patch proposals that may use the trusted fast lane.';
comment on column public.canvas_deck_edit.agent_rendered_at is
  'Stamped by the service after render_proposal successfully rasterizes this proposal.';

-- Freeze eligibility after insertion just like the rest of proposal identity.
create or replace function public.canvas_deck_edit_enforce_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('canvas.allow_edit_content', true) = '1' then
    return new;
  end if;

  if new.workspace_id        is distinct from old.workspace_id        then raise exception 'canvas_deck_edit.workspace_id is immutable';        end if;
  if new.deck_id             is distinct from old.deck_id             then raise exception 'canvas_deck_edit.deck_id is immutable';             end if;
  if new.slide_id            is distinct from old.slide_id            then raise exception 'canvas_deck_edit.slide_id is immutable';            end if;
  if new.kind                is distinct from old.kind                then raise exception 'canvas_deck_edit.kind is immutable';                end if;
  if new.proposed_by         is distinct from old.proposed_by         then raise exception 'canvas_deck_edit.proposed_by is immutable';         end if;
  if new.proposed_by_kind    is distinct from old.proposed_by_kind    then raise exception 'canvas_deck_edit.proposed_by_kind is immutable';    end if;
  if new.new_content         is distinct from old.new_content         then raise exception 'canvas_deck_edit.new_content is immutable';         end if;
  if new.new_slide_payload   is distinct from old.new_slide_payload   then raise exception 'canvas_deck_edit.new_slide_payload is immutable';   end if;
  if new.rationale           is distinct from old.rationale           then raise exception 'canvas_deck_edit.rationale is immutable';           end if;
  if new.created_at          is distinct from old.created_at          then raise exception 'canvas_deck_edit.created_at is immutable';          end if;
  if new.base_version_id     is distinct from old.base_version_id     then raise exception 'canvas_deck_edit.base_version_id is immutable';     end if;
  if new.base_theme_css_hash is distinct from old.base_theme_css_hash then raise exception 'canvas_deck_edit.base_theme_css_hash is immutable'; end if;
  if new.base_nav_js_hash    is distinct from old.base_nav_js_hash    then raise exception 'canvas_deck_edit.base_nav_js_hash is immutable';    end if;
  if new.base_deck_title     is distinct from old.base_deck_title     then raise exception 'canvas_deck_edit.base_deck_title is immutable';     end if;
  if new.auto_apply_eligible is distinct from old.auto_apply_eligible then raise exception 'canvas_deck_edit.auto_apply_eligible is immutable'; end if;
  if new.agent_rendered_at is distinct from old.agent_rendered_at
     and current_setting('canvas.allow_agent_render_mark', true) is distinct from '1' then
    raise exception 'canvas_deck_edit.agent_rendered_at is service-managed';
  end if;
  if new.assistant_message_id is distinct from old.assistant_message_id
     and new.assistant_message_id is not null then
    raise exception 'canvas_deck_edit.assistant_message_id is immutable';
  end if;
  return new;
end;
$$;

revoke execute on function public.canvas_deck_edit_enforce_immutability()
  from public, anon, authenticated;

create or replace function public.canvas_mark_agent_proposal_rendered(
  _edit_id uuid,
  _actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.canvas_deck_edit e
    where e.id = _edit_id
      and e.proposed_by = _actor_id
      and e.proposed_by_kind = 'claude'
      and e.status = 'pending'
  ) then
    return false;
  end if;
  perform set_config('canvas.allow_agent_render_mark', '1', true);
  update public.canvas_deck_edit
  set agent_rendered_at = now()
  where id = _edit_id;
  perform set_config('canvas.allow_agent_render_mark', '0', true);
  return true;
end;
$$;

revoke execute on function public.canvas_mark_agent_proposal_rendered(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.canvas_mark_agent_proposal_rendered(uuid, uuid)
  to service_role;

-- Service-only bridge into the authoritative apply RPC. Explicit validation
-- mirrors the target-table RLS because this SECURITY DEFINER wrapper itself
-- bypasses RLS. It accepts only one safe edit kind and an exact human actor.
create or replace function public.canvas_apply_trusted_agent_edit(
  _edit_id uuid,
  _actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_edit public.canvas_deck_edit;
  v_deck public.canvas_deck;
  v_slide public.canvas_deck_slide;
  v_role public.workspace_role;
  v_previous_sub text;
begin
  select * into v_edit
  from public.canvas_deck_edit
  where id = _edit_id;

  if not found
     or v_edit.status <> 'pending'
     or v_edit.proposed_by <> _actor_id
     or v_edit.proposed_by_kind <> 'claude'
     or v_edit.kind <> 'slide_edit'
     or not v_edit.auto_apply_eligible
     or v_edit.agent_rendered_at is null then
    raise exception 'trusted fast lane: proposal is not an eligible pending agent patch';
  end if;

  select * into v_deck from public.canvas_deck where id = v_edit.deck_id;
  select * into v_slide from public.canvas_deck_slide where id = v_edit.slide_id;
  select wm.role into v_role
  from public.workspace_memberships wm
  where wm.workspace_id = v_edit.workspace_id and wm.user_id = _actor_id;

  if v_role is null or v_role = 'guest' then
    raise exception 'trusted fast lane: actor is not a full workspace member';
  end if;
  if not public.canvas_workspace_allows_self_approval(v_edit.workspace_id) then
    raise exception 'trusted fast lane: workspace self-approval is disabled';
  end if;
  if not coalesce(v_deck.agent_fast_lane_enabled, false) then
    raise exception 'trusted fast lane: deck is not opted in';
  end if;
  if v_role not in ('owner', 'admin') and v_deck.created_by <> _actor_id then
    raise exception 'trusted fast lane: actor does not own this deck';
  end if;
  if v_role not in ('owner', 'admin')
     and not (
       v_slide.owner_id is null
       or v_slide.owner_id = _actor_id
       or v_slide.created_by = _actor_id
     ) then
    raise exception 'trusted fast lane: actor does not own this slide';
  end if;

  -- canvas_apply_edit is the one authoritative apply path. Supply the audited
  -- actor only for this transaction so its self-approval and attribution logic
  -- remains intact.
  v_previous_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', _actor_id::text, true);
  perform public.canvas_apply_edit(_edit_id);
  perform set_config('request.jwt.claim.sub', coalesce(v_previous_sub, ''), true);

  -- The reviewer-routing notification was useful while the proposal waited;
  -- once the verified owner patch lands itself, remove that stale task.
  delete from public.canvas_notification
  where edit_id = _edit_id and kind = 'proposal_waiting';

  return true;
exception
  when others then
    perform set_config(
      'request.jwt.claim.sub',
      coalesce(v_previous_sub, ''),
      true
    );
    raise;
end;
$$;

revoke execute on function public.canvas_apply_trusted_agent_edit(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.canvas_apply_trusted_agent_edit(uuid, uuid)
  to service_role;
