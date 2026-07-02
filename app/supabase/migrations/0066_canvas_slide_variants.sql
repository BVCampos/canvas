-- ============================================================
-- 0066 — A/B slide variants: N sibling proposals, pick one.
--
-- "Give me 3 versions of this slide" produces N canvas_deck_edit rows
-- sharing one variant_group_id; the reviewer picks one and the rest are
-- superseded IN THE SAME TRANSACTION. That sweep is a correctness
-- requirement, not UX polish: canvas_apply_edit has no slide-staleness
-- guard (its only concurrency check is the proposal's own revision), so a
-- lingering pending sibling approved later would silently last-writer-win
-- over the picked one.
--
-- Three pieces:
--   1. variant_group_id — nullable grouping key, write-once like
--      assistant_message_id (0043). Deliberately NOT a new proposal kind
--      and NOT the chat-turn link: a terminal MCP client can produce a
--      variant set with no chat turn, and mutual exclusion is orthogonal
--      to "which reply produced this".
--   2. A fail-closed guard on the GENERIC apply path: applying a grouped
--      row while siblings are still pending raises, so no UI or RPC can
--      double-apply a variant set by accident.
--   3. canvas_apply_variant(_edit_id) — supersede the pending siblings,
--      then delegate to canvas_apply_edit; one transaction, so a failed
--      apply rolls the sweep back too.
-- ============================================================

alter table public.canvas_deck_edit
  add column variant_group_id uuid;

comment on column public.canvas_deck_edit.variant_group_id is
  'Groups sibling proposals that are ALTERNATIVES to choose among (A/B slide variants). '
  'Null for ordinary proposals. Write-once at propose time; approving one member must go '
  'through canvas_apply_variant, which supersedes the rest transactionally.';

create index canvas_deck_edit_variant_group_idx
  on public.canvas_deck_edit (variant_group_id)
  where variant_group_id is not null;

-- ------------------------------------------------------------
-- 1. Freeze variant_group_id (write-once). Full redefinition of the
--    immutability trigger function — body copied from 0057 (the latest)
--    plus the variant clause, mirroring how 0043 froze the chat link.
-- ------------------------------------------------------------

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
  -- Variant membership is decided at propose time, full stop. Allowing a
  -- later re-point would let a row escape (or forge) the pick-one gate.
  if new.variant_group_id is distinct from old.variant_group_id then
    raise exception 'canvas_deck_edit.variant_group_id is immutable';
  end if;
  return new;
end;
$$;

revoke execute on function public.canvas_deck_edit_enforce_immutability()
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Fail-closed pick gate on EVERY apply path. canvas_apply_edit flips
--    status pending→applied; this BEFORE trigger refuses that flip for a
--    grouped row while any sibling is still pending. canvas_apply_variant
--    passes it trivially because it supersedes the siblings first in the
--    same transaction.
-- ------------------------------------------------------------

create or replace function public.canvas_deck_edit_variant_pick_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'applied'
     and old.status = 'pending'
     and old.variant_group_id is not null
     and exists (
       select 1
       from public.canvas_deck_edit s
       where s.variant_group_id = old.variant_group_id
         and s.id <> old.id
         and s.status = 'pending'
     ) then
    raise exception
      'canvas_apply_edit: variant_pick_required — this proposal is one of several alternatives; pick it with canvas_apply_variant so its siblings are superseded in the same transaction';
  end if;
  return new;
end;
$$;

revoke execute on function public.canvas_deck_edit_variant_pick_guard()
  from public, anon, authenticated;

create trigger canvas_deck_edit_variant_pick
  before update of status on public.canvas_deck_edit
  for each row execute function public.canvas_deck_edit_variant_pick_guard();

-- ------------------------------------------------------------
-- 3. The pick: supersede siblings, then apply the chosen one. SECURITY
--    DEFINER like canvas_apply_edit (0039) with the same explicit gates;
--    the inner canvas_apply_edit re-runs its full authorization
--    (edit-rights, pending, revision, self-approval) so this wrapper
--    only owns the sweep.
-- ------------------------------------------------------------

create or replace function public.canvas_apply_variant(
  _edit_id uuid,
  _expected_revision int default null
)
returns public.canvas_slide_version
language plpgsql
security definer
set search_path = public
as $$
declare
  v_edit public.canvas_deck_edit;
begin
  select * into v_edit from public.canvas_deck_edit where id = _edit_id;
  if not found
     or auth.uid() is null
     or not public.canvas_can_edit_deck(v_edit.deck_id) then
    raise exception 'canvas_apply_variant: edit % not found or not accessible', _edit_id;
  end if;
  if v_edit.variant_group_id is null then
    raise exception 'canvas_apply_variant: edit % is not part of a variant set', _edit_id;
  end if;
  if v_edit.status <> 'pending' then
    raise exception 'canvas_apply_variant: edit % is not pending (status=%)', _edit_id, v_edit.status;
  end if;

  -- Sweep the unpicked siblings FIRST (still inside this transaction): the
  -- pick gate above then lets the apply through, and a failed apply rolls
  -- the sweep back with it. 'superseded' (already in the status enum) keeps
  -- these out of the rejected counts analytics reads.
  update public.canvas_deck_edit
     set status      = 'superseded',
         resolved_by = auth.uid(),
         resolved_at = now()
   where variant_group_id = v_edit.variant_group_id
     and id <> _edit_id
     and status = 'pending';

  return public.canvas_apply_edit(_edit_id, _expected_revision);
end;
$$;

grant execute on function public.canvas_apply_variant(uuid, int) to authenticated;
