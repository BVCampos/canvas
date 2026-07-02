// Pending-proposal hygiene (speed discovery 2026-07 #7).
//
// Two mechanisms keep "Review N pending" honest:
//
// 1. SUPERSEDE-ON-PROPOSE — when a proposer lands a NEW pending content
//    proposal on a slide, their OLDER pending content proposals on that same
//    slide are dead weight by construction: each proposal is a full payload
//    resolved against the slide's content at propose time, so approving an
//    older sibling after the newer one would clobber it (batch-approve even
//    assumes one pending per slide). The newer proposal IS the proposer's
//    intent; the older ones flip to 'superseded' immediately.
//
// 2. AGE EXPIRY — pending proposals nobody touched for EXPIRY_DAYS are
//    system-withdrawn: same terminal shape the proposer's own withdraw uses
//    (status 'rejected', resolved_by = proposer), so every existing surface
//    (activity feed, review rail, MCP) already renders it correctly as a
//    withdrawal rather than a reviewer rejection. Prod motivation: 10 pendings,
//    oldest a month stale, each one a lie in the Review badge.
//
// Both are deliberately narrow:
//   • only variant_group_id IS NULL rows — a variant set is N SIBLING pendings
//    on one slide by design; its own pick-one machinery (canvas_apply_variant)
//    sweeps the rest.
//   • supersede only for single-slide CONTENT kinds — structural proposals
//    (create/reorder/delete) and theme edits have no same-slide successor
//    semantics.
//
// Callers run on the service-role client (both writers below are reached from
// service-role contexts); failures are surfaced to the caller to log, never to
// block the propose/list that triggered the sweep.

import type { SupabaseClient } from "@supabase/supabase-js";

// Kinds whose pending rows a newer same-slide, same-proposer proposal makes
// obsolete. Matches the single-slide content kinds previewProposalOnSlide
// merges.
const SUPERSEDABLE_KINDS = ["slide_edit", "slide_html", "slide_styles", "slide_title"];

export const PROPOSAL_EXPIRY_DAYS = 14;

// Flip the proposer's older pending content proposals on this slide to
// 'superseded' (the enum value the variant sweep also uses for "set aside in
// favor of a sibling"). Returns the superseded edit ids so the caller can
// mention them / clean their notifications.
export async function supersedeOlderPendingProposals(
  admin: SupabaseClient,
  input: {
    slideId: string;
    proposedBy: string;
    newEditId: string;
  },
): Promise<string[]> {
  const { data, error } = await admin
    .from("canvas_deck_edit")
    .update({
      status: "superseded",
      resolved_at: new Date().toISOString(),
      resolved_by: input.proposedBy,
    })
    .eq("slide_id", input.slideId)
    .eq("proposed_by", input.proposedBy)
    .eq("status", "pending")
    .is("variant_group_id", null)
    .neq("id", input.newEditId)
    .in("kind", SUPERSEDABLE_KINDS)
    .select("id");
  if (error) throw new Error(`supersede sweep failed: ${error.message}`);

  const ids = (data ?? []).map((row) => row.id as string);
  if (ids.length > 0) {
    // The reviewer-routing notification was for a proposal that no longer
    // needs review — mirror the trusted-fast-lane cleanup.
    await admin
      .from("canvas_notification")
      .delete()
      .in("edit_id", ids)
      .eq("kind", "proposal_waiting");
  }
  return ids;
}

// System-withdraw pending proposals older than EXPIRY_DAYS on one deck.
// Returns the expired edit ids. Cheap no-op when nothing qualifies (partial
// index on status='pending' paths this via the deck+status index).
export async function expireStalePendingProposals(
  admin: SupabaseClient,
  deckId: string,
  maxAgeDays: number = PROPOSAL_EXPIRY_DAYS,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  // resolved_by must equal the proposer for the "withdrawn" (not "rejected by
  // a reviewer") reading everywhere; do it per-proposer via a two-step select
  // + update to keep the write path obvious and RLS-free (service role).
  const { data: stale, error: staleErr } = await admin
    .from("canvas_deck_edit")
    .select("id, proposed_by")
    .eq("deck_id", deckId)
    .eq("status", "pending")
    .is("variant_group_id", null)
    .lt("created_at", cutoff);
  if (staleErr) throw new Error(`stale-proposal lookup failed: ${staleErr.message}`);
  if (!stale || stale.length === 0) return [];

  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const row of stale) {
    const { error } = await admin
      .from("canvas_deck_edit")
      .update({
        status: "rejected",
        resolved_at: now,
        resolved_by: row.proposed_by as string,
      })
      .eq("id", row.id as string)
      .eq("status", "pending");
    if (error) throw new Error(`stale-proposal expiry failed: ${error.message}`);
    ids.push(row.id as string);
  }

  await admin
    .from("canvas_notification")
    .delete()
    .in("edit_id", ids)
    .eq("kind", "proposal_waiting");
  return ids;
}
