-- 0075: the fast-lane choice follows the user across decks.
--
-- The trusted agent fast lane (0057) is a per-deck flag, but the decks it
-- would help most are short-lived — the weeklies are recreated fresh every
-- week — so a per-deck opt-in silently resets the user's decision each time.
-- Prod after four days: 0 of 27 decks enabled. This records a user's last
-- explicit enable/disable and lets decks they create afterwards start from it.
--
--   * canvas_user_fast_lane_default — one row per user: their standing choice,
--     upserted whenever they flip the deck toggle or accept the inline offer.
--   * canvas_deck_inherit_fast_lane — BEFORE INSERT trigger on canvas_deck, so
--     every creation path (web New Deck, MCP create_deck, import, templates)
--     inherits the stored choice without app-code changes. No creation path
--     sets agent_fast_lane_enabled explicitly today, so the incoming value is
--     always the column default (false); only a stored `true` flips it, and a
--     caller that ever passes an explicit true keeps it.
--
-- Safety posture is unchanged: this only seeds the deck flag. Every apply
-- still goes through canvas_apply_trusted_agent_edit's full gate set
-- (deterministic render-verified patch, proposer owns the deck/slide,
-- workspace self-approval on).

create table if not exists public.canvas_user_fast_lane_default (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null,
  updated_at timestamptz not null default now()
);

comment on table public.canvas_user_fast_lane_default is
  'Per-user default for canvas_deck.agent_fast_lane_enabled: the last fast-lane choice the user made on any deck; decks they create inherit it (0075).';

alter table public.canvas_user_fast_lane_default enable row level security;

-- Owner-only in both directions — nothing here is shared or reviewable.
drop policy if exists "users read own fast-lane default" on public.canvas_user_fast_lane_default;
create policy "users read own fast-lane default"
  on public.canvas_user_fast_lane_default for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "users insert own fast-lane default" on public.canvas_user_fast_lane_default;
create policy "users insert own fast-lane default"
  on public.canvas_user_fast_lane_default for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "users update own fast-lane default" on public.canvas_user_fast_lane_default;
create policy "users update own fast-lane default"
  on public.canvas_user_fast_lane_default for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- SECURITY DEFINER so the inherit lookup works regardless of which role runs
-- the deck insert (user RLS session or service role): the pref table's RLS is
-- owner-only and the trigger must read the CREATOR's row, not the caller's.
create or replace function public.canvas_deck_inherit_fast_lane()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_default boolean;
begin
  if new.created_by is not null and not coalesce(new.agent_fast_lane_enabled, false) then
    select enabled into v_default
    from public.canvas_user_fast_lane_default
    where user_id = new.created_by;
    if found and v_default then
      new.agent_fast_lane_enabled := true;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists canvas_deck_inherit_fast_lane on public.canvas_deck;
create trigger canvas_deck_inherit_fast_lane
  before insert on public.canvas_deck
  for each row
  execute function public.canvas_deck_inherit_fast_lane();
