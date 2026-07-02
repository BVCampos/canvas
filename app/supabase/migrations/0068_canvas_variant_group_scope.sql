-- ============================================================
-- 0068 — scope the variant machinery to ONE slide of ONE deck.
--
-- 0066 keyed the pick-one gate on variant_group_id ALONE. A group id is
-- readable off any deck a caller can see (list_proposals returns it), and the
-- RLS insert policy on canvas_deck_edit never constrained variant_group_id —
-- so an editor of deck A could mint a proposal carrying deck B's group id and,
-- by picking their own A row, sweep B's pending variants to 'superseded'
-- (a cross-deck grief). A variant group is, by construction, N alternatives
-- for ONE slide; this migration makes every query that walks the group carry
-- that grain (deck_id + slide_id), and shuts the RLS door so a human proposal
-- can never carry a group id at all.
--
-- Three edits, mirroring 0066's three pieces:
--   1. canvas_apply_variant — the sibling sweep gains deck_id + slide_id.
--   2. canvas_deck_edit_variant_pick_guard — the sibling EXISTS check gains
--      the same, so a foreign row sharing the group id can't wedge a real pick.
--   3. RLS "editors propose edits" — authenticated inserts require
--      variant_group_id IS NULL. Only the service-role MCP path
--      (propose_slide_variants) mints groups; it bypasses RLS. A human RLS
--      proposal has no legitimate reason to set the column.
-- ============================================================

-- ------------------------------------------------------------
-- 1. canvas_apply_variant — sweep scoped to this edit's slide+deck. Body copied
--    verbatim from 0066 plus the two conjuncts on the UPDATE.
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
  -- pick gate below then lets the apply through, and a failed apply rolls the
  -- sweep back with it. 'superseded' (already in the status enum) keeps these
  -- out of the rejected counts analytics reads. Scoped to this edit's slide+
  -- deck: a variant group is N alternatives for ONE slide, so a row carrying
  -- the same group id on a DIFFERENT slide or deck (0066 could not stop that
  -- being inserted) is not a sibling and must not be superseded.
  update public.canvas_deck_edit
     set status      = 'superseded',
         resolved_by = auth.uid(),
         resolved_at = now()
   where variant_group_id = v_edit.variant_group_id
     and deck_id = v_edit.deck_id
     and slide_id = v_edit.slide_id
     and id <> _edit_id
     and status = 'pending';

  return public.canvas_apply_edit(_edit_id, _expected_revision);
end;
$$;

grant execute on function public.canvas_apply_variant(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- 2. Pick guard — the sibling EXISTS check gains the same slide+deck scope.
--    Body copied verbatim from 0066 plus the two conjuncts. The trigger
--    binding (canvas_deck_edit_variant_pick) is unchanged; create-or-replace
--    keeps it pointed at this function.
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
         and s.deck_id = old.deck_id
         and s.slide_id = old.slide_id
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

-- ------------------------------------------------------------
-- 3. RLS: a human proposal may not carry a variant_group_id. Re-creates
--    "editors propose edits" faithfully — the current definition is 0015's
--    insert policy as amended by 0017 (auth.uid() → (select auth.uid()) for the
--    initplan) — plus the one added conjunct. Groups are minted only by the
--    service-role MCP path, which bypasses RLS.
-- ------------------------------------------------------------

drop policy if exists "editors propose edits" on public.canvas_deck_edit;
create policy "editors propose edits"
  on public.canvas_deck_edit for insert
  to authenticated
  with check (
    public.canvas_can_edit_deck(deck_id)
    and proposed_by = (select auth.uid())
    and variant_group_id is null
  );
