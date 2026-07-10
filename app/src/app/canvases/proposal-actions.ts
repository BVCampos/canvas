"use server";

import { revalidatePath } from "next/cache";
import { eligibleForBatch } from "@/lib/canvas/batch-approve";
import {
  buildProposeSlideEditRow,
  type ProposeSlideEditPayload,
} from "@/lib/canvas/propose-slide-html";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { supersedeOlderPendingProposals } from "@/lib/canvas/proposal-hygiene";
import { logUsage } from "@/lib/usage/log";

// Activation funnel: emit activation.first_approved_edit the first time a given
// proposer has an edit applied. Uses the ADMIN client deliberately — the count
// must be GLOBAL (across every deck the proposer ever touched), not filtered by
// the approver's RLS, or an approver who can't see the proposer's other decks
// would miscount and re-fire. Best-effort and fully swallowed: it must never
// affect the approve outcome. Call AFTER the apply RPC has committed.
async function maybeEmitFirstApprovedEdit(
  editId: string,
  deckId: string,
  workspaceId: string | null,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: edit } = await admin
      .from("canvas_deck_edit")
      .select("proposed_by")
      .eq("id", editId)
      .maybeSingle();
    const proposer = edit?.proposed_by as string | undefined;
    if (!proposer) return;

    // status 'applied' is what canvas_apply_edit sets (enum: pending | applied |
    // rejected | superseded). Count exactly 1 ⇒ the one we just applied is their
    // first, so this fires once per proposer over their lifetime.
    const { count } = await admin
      .from("canvas_deck_edit")
      .select("id", { count: "exact", head: true })
      .eq("proposed_by", proposer)
      .eq("status", "applied");
    if (count === 1) {
      logUsage({
        event: "activation.first_approved_edit",
        surface: "action",
        user_id: proposer,
        workspace_id: workspaceId,
        deck_id: deckId,
        status: "ok",
      });
    }
  } catch (err) {
    console.error("[activation:first_approved_edit]", err);
  }
}

// Server actions for the proposal review surface. Every mutation goes through
// the user's RLS-aware client. Since 0039 canvas_apply_edit is SECURITY
// DEFINER: approval authority is canvas_can_edit_deck, checked explicitly in
// the RPC, and an approvable proposal always applies (per-row creator/owner
// RLS no longer re-litigates the decision underneath the approve button).

export type ProposalActionResult =
  | { ok: true }
  // `code` carries a stable token for cases the UI handles specially:
  // "stale" — the optimistic-concurrency miss (the proposal was edited after
  // the caller loaded it); "needs_reviewer" — revertProposal hit the
  // self-approval guard, so the undo must go through a teammate. Absent for
  // generic failures.
  | { ok: false; error: string; code?: "stale" | "needs_reviewer" };

// canvas_apply_edit raises plain-text P0001 exceptions. Translate the ones a
// user can actually act on into sentences; fall through to the raw message for
// genuine anomalies. A real user session showed what an unmapped raise
// costs: 8 retries of the same failing Approve click.
function humanizeApplyError(message: string): string {
  if (message.includes("is not pending")) {
    return "This proposal was already approved, rejected, or withdrawn. Reload to see its current state.";
  }
  if (message.includes("approve their own proposal")) {
    return "You can't approve your own proposal in this workspace — ask a teammate to review it, or an admin to enable self-approval.";
  }
  if (message.includes("only slide")) {
    return "This would delete the deck's only slide, which isn't allowed.";
  }
  if (message.includes("already deleted")) {
    return "The slide this proposal targets no longer exists — it was probably deleted by another proposal. You can reject this one.";
  }
  if (message.includes("not found or not accessible")) {
    return "You don't have permission to decide proposals on this deck.";
  }
  if (message.includes("variant_pick_required")) {
    return "This proposal is one of several alternatives — pick one option in the Ask-agent panel; the others are set aside automatically.";
  }
  return message;
}

// Whole-state replacement for a pending proposal's editable content. The caller
// sends the COMPLETE intended state (the edit form is pre-filled), not a sparse
// patch — `rationale` set to null clears it. `expected_revision` is the
// revision the caller loaded; canvas_update_edit rejects the write if the
// proposal moved on since (concurrent edit).
export type ProposalEditPatch = {
  new_content?: string | null;
  new_slide_payload?: Record<string, unknown> | null;
  rationale?: string | null;
  expected_revision: number;
};

// Look up an edit's workspace_id + kind for usage event attribution. RLS
// gates the read so non-members get null — which is fine: the usage row
// will still write (workspace_id is nullable) but won't be visible to
// non-admins. Returns null fields on a missing row.
async function editContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  editId: string,
): Promise<{ workspace_id: string | null; kind: string | null }> {
  const { data } = await supabase
    .from("canvas_deck_edit")
    .select("workspace_id, kind")
    .eq("id", editId)
    .maybeSingle();
  return {
    workspace_id: data?.workspace_id ?? null,
    kind: (data?.kind as string | undefined) ?? null,
  };
}

export async function approveProposal(
  editId: string,
  deckId: string,
  // The revision the reviewer was looking at when they clicked Approve. Passed
  // to canvas_apply_edit as _expected_revision so an edit landed after the
  // reviewer opened the proposal blocks the apply (optimistic concurrency)
  // rather than silently approving content they never saw. Omit to skip the
  // guard (back-compat for callers that don't track revision).
  expectedRevision?: number,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const ctx = await editContext(supabase, editId);

  const { error } = await supabase.rpc("canvas_apply_edit", {
    _edit_id: editId,
    _expected_revision: expectedRevision ?? null,
  });
  if (error) {
    console.error("[approveProposal]", error);
    const stale = (error.message ?? "").includes(
      "proposal_changed_since_review",
    );
    logUsage({
      event: "proposal.approve",
      surface: "action",
      user_id: user.id,
      workspace_id: ctx.workspace_id,
      deck_id: deckId,
      status: stale ? "denied" : "error",
      duration_ms: Date.now() - started,
      error_code: stale ? "proposal_changed_since_review" : error.code ?? "rpc_error",
      props: { edit_id: editId, edit_kind: ctx.kind },
    });
    if (stale) {
      return {
        ok: false,
        code: "stale",
        error:
          "This proposal was edited after you opened it. Reload to review the latest version before approving.",
      };
    }
    return { ok: false, error: humanizeApplyError(error.message) };
  }

  logUsage({
    event: "proposal.approve",
    surface: "action",
    user_id: user.id,
    workspace_id: ctx.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId, edit_kind: ctx.kind },
  });
  void maybeEmitFirstApprovedEdit(editId, deckId, ctx.workspace_id);

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

// Pick ONE variant from an A/B set (migration 0066): canvas_apply_variant
// supersedes the pending siblings and applies the chosen edit in a single
// transaction. The generic approve path fail-closes on a grouped row only WHILE
// a sibling is still pending (a last surviving member applies through it
// normally), so what's guaranteed is that two siblings can never both apply —
// the last-writer-wins hazard is structurally impossible.
export async function applyVariant(
  editId: string,
  deckId: string,
  expectedRevision?: number,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const ctx = await editContext(supabase, editId);

  const { error } = await supabase.rpc("canvas_apply_variant", {
    _edit_id: editId,
    _expected_revision: expectedRevision ?? null,
  });
  if (error) {
    console.error("[applyVariant]", error);
    // canvas_apply_variant delegates to canvas_apply_edit, so it raises the
    // same optimistic-concurrency miss when the picked variant moved on after
    // the reviewer loaded it. Handle it exactly like approveProposal — a
    // friendly {code:"stale"} the variant card can act on — instead of letting
    // the raw Postgres text render in the alert.
    const stale = (error.message ?? "").includes("proposal_changed_since_review");
    logUsage({
      event: "proposal.apply_variant",
      surface: "action",
      user_id: user.id,
      workspace_id: ctx.workspace_id,
      deck_id: deckId,
      status: stale ? "denied" : "error",
      duration_ms: Date.now() - started,
      error_code: stale ? "proposal_changed_since_review" : error.code ?? "rpc_error",
      props: { edit_id: editId },
    });
    if (stale) {
      return {
        ok: false,
        code: "stale",
        error:
          "This proposal was edited after you opened it. Reload to review the latest version before approving.",
      };
    }
    return { ok: false, error: humanizeApplyError(error.message) };
  }

  logUsage({
    event: "proposal.apply_variant",
    surface: "action",
    user_id: user.id,
    workspace_id: ctx.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId },
  });
  void maybeEmitFirstApprovedEdit(editId, deckId, ctx.workspace_id);

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

export type BulkApproveResult = {
  approved: number;
  failed: Array<{ editId: string; error: string }>;
};

// Bulk approve — the inbox's "Approve N from Claude". The client sends the
// ids it believes are eligible, but eligibility is RE-VERIFIED here with the
// shared rule (lib/canvas/batch-approve) against fresh rows: by the time the
// click lands, a second proposal may have arrived on a target or a slide may
// have moved on. Ineligible ids are reported as failures, never silently
// applied. Sequential rather than parallel so we don't fire concurrent
// canvas_apply_edit RPCs against the same slide — the RPC bumps
// slide_version and a parallel pair would race the optimistic-version guard.
// Each approval is its own RPC and its own usage event; failures collect
// into a per-row summary. Revalidates once at the end.
export async function approveAllProposals(
  proposals: Array<{ editId: string; deckId: string }>,
): Promise<BulkApproveResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      approved: 0,
      failed: proposals.map((p) => ({ editId: p.editId, error: "not_authenticated" })),
    };
  }

  const failed: BulkApproveResult["failed"] = [];
  const approvedEdits: Array<{ editId: string; deckId: string }> = [];
  const touchedDecks = new Set<string>();

  // Fresh state for the re-verification: the requested rows, the FULL
  // pending universe across their decks (the exactly-one-per-target rule has
  // to count proposals the batch skips), and the touched slides' current
  // versions for the staleness test. RLS scopes every read.
  const requestedIds = proposals.map((p) => p.editId);
  const { data: requestedRows, error: requestedErr } = requestedIds.length
    ? await supabase
        .from("canvas_deck_edit")
        .select("id, deck_id, slide_id, kind, proposed_by_kind, base_version_id, status")
        .in("id", requestedIds)
    : { data: [], error: null };
  if (requestedErr) {
    console.error("[approveAllProposals] lookup", requestedErr);
    return {
      approved: 0,
      failed: proposals.map((p) => ({ editId: p.editId, error: requestedErr.message })),
    };
  }
  const requestedById = new Map((requestedRows ?? []).map((r) => [r.id, r]));
  const universeDeckIds = Array.from(
    new Set((requestedRows ?? []).map((r) => r.deck_id as string)),
  );
  const { data: pendingRows } = universeDeckIds.length
    ? await supabase
        .from("canvas_deck_edit")
        .select("id, deck_id, slide_id, kind, proposed_by_kind, base_version_id")
        .eq("status", "pending")
        .in("deck_id", universeDeckIds)
    : { data: [] };
  const pendingUniverse = (pendingRows ?? []) as Array<{
    id: string;
    deck_id: string;
    slide_id: string | null;
    kind: string;
    proposed_by_kind: string;
    base_version_id: string | null;
  }>;
  const universeSlideIds = Array.from(
    new Set(
      pendingUniverse
        .map((r) => r.slide_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const { data: slideRows } = universeSlideIds.length
    ? await supabase
        .from("canvas_deck_slide")
        .select("id, current_version_id")
        .in("id", universeSlideIds)
    : { data: [] };
  const currentVersionBySlide = new Map(
    ((slideRows ?? []) as { id: string; current_version_id: string | null }[]).map(
      (s) => [s.id, s.current_version_id],
    ),
  );
  const eligibleIds = new Set(
    eligibleForBatch(pendingUniverse, currentVersionBySlide).map((r) => r.id),
  );

  for (const { editId, deckId } of proposals) {
    const started = Date.now();
    const row = requestedById.get(editId);
    if (!row || row.status !== "pending") {
      failed.push({
        editId,
        error: "This proposal is no longer pending.",
      });
      continue;
    }
    if (!eligibleIds.has(editId)) {
      failed.push({
        editId,
        error:
          "No longer batch-eligible (stale, or its target gained another pending proposal) — review it individually.",
      });
      continue;
    }
    const ctx = await editContext(supabase, editId);
    const { error } = await supabase.rpc("canvas_apply_edit", { _edit_id: editId });
    if (error) {
      console.error("[approveAllProposals]", editId, error);
      logUsage({
        event: "proposal.approve",
        surface: "action",
        user_id: user.id,
        workspace_id: ctx.workspace_id,
        deck_id: deckId,
        status: "error",
        duration_ms: Date.now() - started,
        error,
        error_code: error.code ?? "rpc_error",
        props: { edit_id: editId, edit_kind: ctx.kind, bulk: true },
      });
      failed.push({ editId, error: humanizeApplyError(error.message) });
      continue;
    }
    logUsage({
      event: "proposal.approve",
      surface: "action",
      user_id: user.id,
      workspace_id: ctx.workspace_id,
      deck_id: deckId,
      status: "ok",
      duration_ms: Date.now() - started,
      props: { edit_id: editId, edit_kind: ctx.kind, bulk: true },
    });
    void maybeEmitFirstApprovedEdit(editId, deckId, ctx.workspace_id);
    approvedEdits.push({ editId, deckId });
    touchedDecks.add(deckId);
  }

  // Mirror the path set the single approveProposal touches. (The standalone
  // proposal page is a redirect now, so there's no per-proposal detail path
  // left to revalidate.)
  if (approvedEdits.length > 0) {
    revalidatePath("/canvases");
    revalidatePath("/canvases/inbox");
    for (const deckId of touchedDecks) {
      revalidatePath(`/canvases/${deckId}`);
      revalidatePath(`/canvases/${deckId}/history`);
    }
  }

  return { approved: approvedEdits.length, failed };
}

// Undo for a just-approved slide-content proposal — the chip's "Undo (U)".
// Ports the MCP revert_proposal logic (lib/canvas/mcp/tools.ts): load the
// applied edit, walk the version log to the pre-change state, and refuse if
// the slide has moved past the version this approval produced (anti-clobber —
// reverting then would also erase the newer edits). Unlike MCP, which leaves
// a pending revert for review, this inserts the revert proposal AND applies
// it immediately via the same canvas_apply_edit path approveProposal uses:
// the caller just approved the original, so they hold approval authority —
// and the RPC re-checks regardless.
export async function revertProposal(
  editId: string,
  deckId: string,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: edit, error: editErr } = await supabase
    .from("canvas_deck_edit")
    .select("id, workspace_id, deck_id, slide_id, kind, status")
    .eq("id", editId)
    .maybeSingle();
  if (editErr) {
    console.error("[revertProposal] edit lookup", editErr);
    return { ok: false, error: editErr.message };
  }
  if (!edit) return { ok: false, error: "Proposal not found." };
  if (edit.status !== "applied") {
    return { ok: false, error: "Only an applied proposal can be undone." };
  }

  // The version this approval produced carries source_edit_id; its parent is
  // the slide state immediately before the change. Structural/deck kinds
  // (create/delete/reorder/theme/nav/title) produce no such version — the
  // chip never offers Undo for them, mirroring the MCP guard.
  const { data: created, error: versionErr } = await supabase
    .from("canvas_slide_version")
    .select("id, slide_id, version_no, parent_version_id")
    .eq("source_edit_id", editId)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (versionErr) {
    console.error("[revertProposal] version lookup", versionErr);
    return { ok: false, error: versionErr.message };
  }
  if (!created) {
    return {
      ok: false,
      error:
        "This change can't be undone automatically — restore from History instead.",
    };
  }
  if (!created.parent_version_id) {
    return {
      ok: false,
      error:
        "This approval created the slide's first version — there is nothing earlier to restore.",
    };
  }

  const { data: parent, error: parentErr } = await supabase
    .from("canvas_slide_version")
    .select("id, version_no, title, html_body, slide_styles")
    .eq("id", created.parent_version_id)
    .maybeSingle();
  if (parentErr) {
    console.error("[revertProposal] parent lookup", parentErr);
    return { ok: false, error: parentErr.message };
  }
  if (!parent) {
    return {
      ok: false,
      error:
        "The pre-change version is no longer in the history — restore from History instead.",
    };
  }

  // Anti-clobber: if the slide's current version has moved past the version
  // this approval produced (another approve, a hand edit), reverting would
  // also wipe the newer content. Refuse and route to History — never force.
  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("id, current_version_id")
    .eq("id", created.slide_id)
    .maybeSingle();
  if (slideErr) {
    console.error("[revertProposal] slide lookup", slideErr);
    return { ok: false, error: slideErr.message };
  }
  if (!slide) {
    return { ok: false, error: "The slide no longer exists." };
  }
  if (slide.current_version_id !== created.id) {
    logUsage({
      event: "proposal.revert",
      surface: "action",
      user_id: user.id,
      workspace_id: edit.workspace_id,
      deck_id: deckId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "slide_changed_since",
      props: { edit_id: editId, edit_kind: edit.kind },
    });
    return {
      ok: false,
      error: "slide changed since — restore from History instead",
    };
  }

  const { data: revert, error: insertErr } = await supabase
    .from("canvas_deck_edit")
    .insert({
      workspace_id: edit.workspace_id,
      deck_id: edit.deck_id,
      slide_id: slide.id,
      kind: "slide_edit",
      proposed_by: user.id,
      proposed_by_kind: "user",
      new_content: null,
      new_slide_payload: {
        title: parent.title ?? "",
        html_body: parent.html_body,
        slide_styles: parent.slide_styles ?? "",
      },
      rationale: `Revert of ${editId} (undo from review)`,
      status: "pending",
      base_version_id: slide.current_version_id,
      // Explicit link to the applied edit being undone (0040). The apply
      // RPC's self-approval guard recognizes "reverting an edit I resolved"
      // through this column; the rationale above is human context only.
      reverts_edit_id: editId,
    })
    .select("id")
    .single();
  if (insertErr || !revert) {
    console.error("[revertProposal] insert", insertErr);
    return {
      ok: false,
      error: insertErr?.message ?? "Could not create the revert.",
    };
  }

  const { error: applyErr } = await supabase.rpc("canvas_apply_edit", {
    _edit_id: revert.id,
  });
  if (applyErr) {
    console.error("[revertProposal] apply", applyErr);
    // Best-effort: withdraw the revert proposal so a failed undo doesn't
    // leave a stray pending row in the review queue. The proposer (us) is
    // always allowed to withdraw their own pending proposal.
    await supabase.rpc("canvas_withdraw_edit", { _edit_id: revert.id });
    logUsage({
      event: "proposal.revert",
      surface: "action",
      user_id: user.id,
      workspace_id: edit.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error: applyErr,
      error_code: applyErr.code ?? "rpc_error",
      props: { edit_id: editId, edit_kind: edit.kind },
    });
    // The self-approval guard's message ("you can't approve your own
    // proposal") reads nonsensically through the chip's undo strip — name
    // the actual constraint instead. Post-0040 this only fires when the
    // caller reverts an edit someone ELSE resolved.
    if ((applyErr.message ?? "").includes("approve their own proposal")) {
      return {
        ok: false,
        code: "needs_reviewer",
        error: "undo needs a reviewer in this workspace",
      };
    }
    return { ok: false, error: humanizeApplyError(applyErr.message) };
  }

  logUsage({
    event: "proposal.revert",
    surface: "action",
    user_id: user.id,
    workspace_id: edit.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: {
      edit_id: editId,
      edit_kind: edit.kind,
      restored_version_no: parent.version_no,
    },
  });

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

export async function rejectProposal(
  editId: string,
  deckId: string,
  reason?: string,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const ctx = await editContext(supabase, editId);
  const trimmed = reason?.trim();
  const { error } = await supabase.rpc("canvas_reject_edit", {
    _edit_id: editId,
    _reason: trimmed && trimmed.length > 0 ? trimmed : null,
  });
  if (error) {
    console.error("[rejectProposal]", error);
    logUsage({
      event: "proposal.reject",
      surface: "action",
      user_id: user.id,
      workspace_id: ctx.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "rpc_error",
      props: { edit_id: editId, edit_kind: ctx.kind, has_reason: !!trimmed },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "proposal.reject",
    surface: "action",
    user_id: user.id,
    workspace_id: ctx.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId, edit_kind: ctx.kind, has_reason: !!trimmed },
  });

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

export async function withdrawProposal(
  editId: string,
  deckId: string,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const ctx = await editContext(supabase, editId);
  const { error } = await supabase.rpc("canvas_withdraw_edit", { _edit_id: editId });
  if (error) {
    console.error("[withdrawProposal]", error);
    logUsage({
      event: "proposal.withdraw",
      surface: "action",
      user_id: user.id,
      workspace_id: ctx.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "rpc_error",
      props: { edit_id: editId, edit_kind: ctx.kind },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "proposal.withdraw",
    surface: "action",
    user_id: user.id,
    workspace_id: ctx.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId, edit_kind: ctx.kind },
  });

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

// Revise a pending proposal in place. Routes through canvas_update_edit
// (SECURITY INVOKER), which re-checks proposer-or-approver, re-bases the diff
// to current target state, bumps the revision, and drops an audit comment.
// The immutability trigger still freezes content on every other write path —
// this RPC is the only authorized content-mutation route.
export async function updateProposal(
  editId: string,
  deckId: string,
  patch: ProposalEditPatch,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const ctx = await editContext(supabase, editId);

  const { error } = await supabase.rpc("canvas_update_edit", {
    _edit_id: editId,
    _new_content: patch.new_content ?? null,
    _new_slide_payload: patch.new_slide_payload ?? null,
    _rationale: patch.rationale ?? null,
    _expected_revision: patch.expected_revision,
  });
  if (error) {
    console.error("[updateProposal]", error);
    const stale = (error.message ?? "").includes("proposal_changed_since_load");
    logUsage({
      event: "proposal.edit",
      surface: "action",
      user_id: user.id,
      workspace_id: ctx.workspace_id,
      deck_id: deckId,
      status: stale ? "denied" : "error",
      duration_ms: Date.now() - started,
      error_code: stale ? "proposal_changed_since_load" : error.code ?? "rpc_error",
      props: { edit_id: editId, edit_kind: ctx.kind },
    });
    if (stale) {
      return {
        ok: false,
        code: "stale",
        error:
          "This proposal was edited elsewhere since you opened it. Reload to get the latest version, then re-apply your changes.",
      };
    }
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "proposal.edit",
    surface: "action",
    user_id: user.id,
    workspace_id: ctx.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId, edit_kind: ctx.kind },
  });

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${deckId}`);
  revalidatePath(`/canvases/${deckId}/history`);
  return { ok: true };
}

export async function commentOnProposal(
  editId: string,
  body: string,
  deckId: string,
): Promise<ProposalActionResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "body_required" };

  // Resolve workspace_id from the edit row — RLS gates the read so non-members
  // get null here rather than a leaked row.
  const { data: edit } = await supabase
    .from("canvas_deck_edit")
    .select("workspace_id")
    .eq("id", editId)
    .maybeSingle();
  if (!edit?.workspace_id) return { ok: false, error: "proposal_not_found" };

  const { error } = await supabase.from("canvas_edit_comment").insert({
    workspace_id: edit.workspace_id,
    edit_id: editId,
    author_kind: "user",
    author_id: user.id,
    body: trimmed,
  });
  if (error) {
    console.error("[commentOnProposal]", error);
    logUsage({
      event: "proposal.comment",
      surface: "action",
      user_id: user.id,
      workspace_id: edit.workspace_id,
      deck_id: deckId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "insert_error",
      props: { edit_id: editId, body_len: trimmed.length },
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "proposal.comment",
    surface: "action",
    user_id: user.id,
    workspace_id: edit.workspace_id,
    deck_id: deckId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { edit_id: editId, body_len: trimmed.length },
  });

  revalidatePath(`/canvases/${deckId}`);
  return { ok: true };
}

// A member's hand edit, routed through a proposal instead of a direct commit.
// The in-place edit surfaces (Adjust / Edit-text / Inspect) are open to every
// member now; a member who CAN direct-save (slide owner/creator or workspace
// admin) still commits via saveSlideHtmlDirect, but one who can't sends their
// Save here and it lands as a PENDING slide_edit a reviewer approves — the same
// propose → approve loop Claude's edits go through.
//
// The inserted row mirrors the MCP propose_slide_edit tool (lib/canvas/mcp/
// tools.ts) exactly: kind='slide_edit', new_content=null, new_slide_payload
// carrying html_body (+ optional slide_styles/title), base_version_id stamped
// from the version the editor opened against so the chip's staleness guard can
// fire. The differences from the MCP path are deliberate: proposed_by_kind is
// 'user' (a human hand edit, not Claude), and we use the RLS-aware client, so
// the "editors propose edits" policy (canvas_can_edit_deck AND proposed_by =
// auth.uid()) is the authority on whether this member may propose at all.
export type ProposeSlideEditResult =
  | { ok: true; editId: string }
  | { ok: false; error: string };

export async function proposeSlideHtmlEdit(args: {
  slideId: string;
  deckId: string;
  htmlBody: string;
  slideStyles?: string;
  title?: string;
  baseVersionNo?: number | null;
  rationale?: string;
}): Promise<ProposeSlideEditResult> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  // Resolve the slide's workspace + current version under the member's RLS.
  // current_version_id is the propose-time base — the same value the MCP tool
  // stores as base_version_id. Reading it here (rather than trusting a value
  // passed from the client) keeps the staleness stamp honest; baseVersionNo is
  // accepted for parity with the MCP signature and used only for the version
  // echo check below.
  const { data: slide, error: slideErr } = await supabase
    .from("canvas_deck_slide")
    .select("workspace_id, deck_id, current_version_id")
    .eq("id", args.slideId)
    .eq("deck_id", args.deckId)
    .maybeSingle();
  if (slideErr) {
    console.error("[proposeSlideHtmlEdit] slide lookup", slideErr);
    return { ok: false, error: slideErr.message };
  }
  if (!slide) return { ok: false, error: "slide_not_found" };
  const workspaceId = (slide.workspace_id as string | null) ?? null;
  const baseVersionId = (slide.current_version_id as string | null) ?? null;

  // Version echo (optimistic-concurrency, same intent as the MCP tool): if the
  // caller tells us which version they edited and the slide has moved past it,
  // refuse — proposing from a stale copy would, on approval, silently revert the
  // newer edit. The version NUMBER lives on the version row, not the slide
  // (`current_version_no` is derived everywhere — the slide loader and the MCP
  // read tools both join it), so resolve it through current_version_id. A slide
  // with no version row yet has nothing to clobber, so the check is skipped.
  // The chip's staleness gate is the second line of defense (it can still fire
  // if the slide moves on AFTER the proposal lands).
  if (args.baseVersionNo != null && baseVersionId) {
    const { data: currentVersion, error: versionErr } = await supabase
      .from("canvas_slide_version")
      .select("version_no")
      .eq("id", baseVersionId)
      .maybeSingle();
    // A failed lookup must not silently skip the gate (that's the exact clobber
    // it guards against) — surface it like the slide lookup above; retryable.
    if (versionErr) {
      console.error("[proposeSlideHtmlEdit] version lookup", versionErr);
      return { ok: false, error: versionErr.message };
    }
    if (
      currentVersion?.version_no != null &&
      currentVersion.version_no !== args.baseVersionNo
    ) {
      return {
        ok: false,
        error:
          "This slide changed since you started editing — refresh to see the latest, then re-apply your change.",
      };
    }
  }

  const built = buildProposeSlideEditRow({
    slideId: args.slideId,
    htmlBody: args.htmlBody,
    slideStyles: args.slideStyles,
    title: args.title,
    rationale: args.rationale,
    baseVersionId,
  });
  if (!built.ok) return { ok: false, error: built.error };

  const { data: edit, error } = await supabase
    .from("canvas_deck_edit")
    .insert({
      workspace_id: workspaceId,
      deck_id: args.deckId,
      slide_id: built.row.slide_id,
      kind: built.row.kind,
      proposed_by: user.id,
      proposed_by_kind: built.row.proposed_by_kind,
      new_content: built.row.new_content,
      // new_slide_payload is jsonb; the typed payload satisfies the
      // content-shape CHECK (html_body is a string).
      new_slide_payload: built.row.new_slide_payload as ProposeSlideEditPayload,
      rationale: built.row.rationale,
      status: built.row.status,
      base_version_id: built.row.base_version_id,
    })
    .select("id")
    .single();
  if (error || !edit) {
    console.error("[proposeSlideHtmlEdit] insert", error);
    logUsage({
      event: "proposal.create",
      surface: "action",
      user_id: user.id,
      workspace_id: workspaceId,
      deck_id: args.deckId,
      slide_id: args.slideId,
      status: "error",
      duration_ms: Date.now() - started,
      error_code: error?.code ?? "insert_error",
      props: { kind: "slide_edit", proposed_by_kind: "user", from_inline_edit: true },
    });
    // RLS rejection (a member who genuinely can't edit this deck) surfaces as a
    // generic insert failure — name the constraint rather than leaking the raw
    // policy error.
    return {
      ok: false,
      error:
        error?.message ??
        "Couldn't propose this change — you may not have permission to edit this deck.",
    };
  }

  logUsage({
    event: "proposal.create",
    surface: "action",
    user_id: user.id,
    workspace_id: workspaceId,
    deck_id: args.deckId,
    slide_id: args.slideId,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { kind: "slide_edit", proposed_by_kind: "user", from_inline_edit: true },
  });

  // Same supersede-on-propose sweep as the MCP propose tools: this member's
  // OLDER pending proposals on the slide are dead weight once this one lands.
  // Advisory — never fail a committed proposal over sweep trouble.
  try {
    await supersedeOlderPendingProposals(createAdminClient(), {
      slideId: args.slideId,
      proposedBy: user.id,
      newEditId: edit.id as string,
    });
  } catch (e) {
    console.error("[proposeSlideHtmlEdit] supersede sweep failed:", e);
  }

  revalidatePath("/canvases");
  revalidatePath("/canvases/inbox");
  revalidatePath(`/canvases/${args.deckId}`);
  revalidatePath(`/canvases/${args.deckId}/history`);
  return { ok: true, editId: edit.id };
}
