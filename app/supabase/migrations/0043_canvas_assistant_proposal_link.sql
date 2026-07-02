-- ============================================================
-- Canvas in-app assistant — link proposals to turns  (migration 0043, ADR-0006)
-- ============================================================
-- The in-app chatbox (0041/0042) and the local `canvas-agent` bridge produce
-- edits the SAME way terminal Claude does: every change is a pending
-- canvas_deck_edit proposal that lands in the review rail. Until now nothing
-- tied a proposal back to the chat turn that produced it, so the chatbox could
-- only say "check the rail" and the user had to leave the panel to act.
--
-- This adds an optional link from a proposal to the assistant REPLY message it
-- was produced under, so the web chatbox can surface a turn's proposals inline
-- and approve/undo them through the same review code path (no second approve
-- surface — see the UI-clarity one-act-one-path rule). The MCP propose handlers
-- stamp it when a streaming assistant turn for (user, deck) is in flight; every
-- other propose path (terminal Claude, no live turn) leaves it null and behaves
-- exactly as before.
--
-- Ships WITH the assistant code and on top of 0042 (also not yet on prod).
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / IF NOT EXISTS).
-- ============================================================

-- ------------------------------------------------------------
-- 1. The link column.
--    on delete set null: a proposal is a real edit in the rail and must
--    OUTLIVE the chat — deleting a thread (which cascades its messages, 0042)
--    only severs the chat link; the pending/applied proposal stays intact.
-- ------------------------------------------------------------
alter table public.canvas_deck_edit
  add column if not exists assistant_message_id uuid
    references public.canvas_assistant_message(id) on delete set null;

comment on column public.canvas_deck_edit.assistant_message_id is
  'When set, the assistant REPLY message (canvas_assistant_message, role=assistant) this proposal was produced under, so the in-app chatbox can surface + review it inline. Null for every non-chatbox propose path. See ADR-0006.';

-- Lookup: "the proposals for these assistant messages" (the chatbox query).
create index if not exists canvas_deck_edit_assistant_message_idx
  on public.canvas_deck_edit (assistant_message_id)
  where assistant_message_id is not null;

-- ------------------------------------------------------------
-- 2. Freeze the link post-insert (defense in depth).
--    Re-created verbatim from the 0035 definition with ONE added check: the
--    link is set once at propose time (by the service-role MCP path, to the
--    caller's own streaming turn) and never legitimately changes afterward.
--    Freezing it stops a member who can UPDATE the row (the broad "members
--    resolve edits" policy) from re-pointing a proposal at someone else's
--    chat turn to inject a card into their panel.
--
--    The guard allows a transition TO null so the FK's `on delete set null`
--    (firing as an UPDATE when the linked message is deleted) still succeeds.
--    As in 0035, the canvas.allow_edit_content GUC short-circuit lets
--    canvas_update_edit revise content; it does not touch this column.
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
  -- The chat link is write-once at propose time. Allow it to be cleared to null
  -- (the FK's on-delete-set-null) but never set or re-pointed afterward.
  if new.assistant_message_id is distinct from old.assistant_message_id
     and new.assistant_message_id is not null then
    raise exception 'canvas_deck_edit.assistant_message_id is immutable';
  end if;
  return new;
end;
$$;

revoke execute on function public.canvas_deck_edit_enforce_immutability() from public, anon, authenticated;
