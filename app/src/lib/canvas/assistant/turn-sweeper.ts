import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

// Turn-lifecycle sweeper (assistant speed discovery 2026-07 #5).
//
// Two classes of ghost rows haunted the panel:
//
//   • QUEUED-FOREVER — a prompt queued into a dead bridge (or an openrouter
//     prompt whose client died before POSTing /run) sits `queued`
//     indefinitely: prod had 4 rows rotting since June. Nothing expired them,
//     so the thread showed an eternal "working…".
//   • STRANDED IN-FLIGHT — the OpenRouter turn runs inside the client-held
//     POST; a deploy/restart mid-turn leaves `running`/`streaming` rows with
//     no janitor. (The bridge poll route reaps ITS runtime's rows, but only
//     while a bridge is polling — a bridge that never comes back reaps
//     nothing.)
//
// This sweep runs when the user hydrates a thread in the panel (the exact
// moment they'd otherwise stare at a ghost spinner) and before a new send.
// Scoped to one user + thread; every write is guarded by the current status so
// a live turn that settles concurrently can't be clobbered. Partial content on
// a streaming row is kept — only the status flips.

// A queued prompt is picked up in seconds when its runtime is alive (the
// client POSTs /run immediately; the bridge polls every ~2s). Ten minutes
// queued means nothing is coming for it.
export const QUEUED_EXPIRY_MS = 10 * 60 * 1000;
// The assistant `streaming` row heartbeats via the runner's ≤400ms flushes,
// but the user `running` row is written ONLY at claim and settle — it never
// heartbeats. The 30-minute cutoff is safe for it purely because turns are
// bounded far below it: OpenRouter by MAX_TOOL_ROUNDS (maxDuration 300s is a
// Vercel hint `next start` on the EC2 self-host does NOT enforce), the bridge
// by its TURN_TIMEOUT_MS (120s). If a turn cap is ever raised toward this
// cutoff, add a user-row heartbeat first or the sweep will flip a healthy
// long turn's user row to `error` mid-run.
export const STRANDED_EXPIRY_MS = 30 * 60 * 1000;

export const QUEUED_EXPIRED_BRIDGE_MESSAGE =
  "This prompt was never picked up — is your agent bridge running? Start it and send again.";
export const QUEUED_EXPIRED_OPENROUTER_MESSAGE =
  "This turn never started. Send the message again.";
export const STRANDED_MESSAGE =
  "This turn was interrupted before it finished (the server restarted mid-turn). Partial output is kept — send a follow-up to continue.";

export type SweepCounts = {
  expiredQueued: number;
  strandedUsers: number;
  strandedAssistants: number;
};

export async function sweepStaleAssistantRows(
  admin: SupabaseClient,
  input: { userId: string; threadId: string },
  now: number = Date.now(),
): Promise<SweepCounts> {
  const queuedCutoff = new Date(now - QUEUED_EXPIRY_MS).toISOString();
  const strandedCutoff = new Date(now - STRANDED_EXPIRY_MS).toISOString();
  const counts: SweepCounts = {
    expiredQueued: 0,
    strandedUsers: 0,
    strandedAssistants: 0,
  };

  // 1) Expire abandoned queued prompts, with a runtime-specific terminal
  //    message so the user knows WHY nothing happened.
  const { data: queued, error: queuedErr } = await admin
    .from("canvas_assistant_message")
    .select("id, execution_runtime")
    .eq("user_id", input.userId)
    .eq("thread_id", input.threadId)
    .eq("role", "user")
    .eq("status", "queued")
    .lt("created_at", queuedCutoff);
  if (queuedErr) {
    console.error("[assistant:sweep:queued-select]", queuedErr);
  }
  for (const row of queued ?? []) {
    const { error } = await admin
      .from("canvas_assistant_message")
      .update({
        status: "error",
        error:
          row.execution_runtime === "openrouter"
            ? QUEUED_EXPIRED_OPENROUTER_MESSAGE
            : QUEUED_EXPIRED_BRIDGE_MESSAGE,
      })
      .eq("id", row.id as string)
      // Guard: a poll/claim that raced us must win.
      .eq("status", "queued");
    if (error) console.error("[assistant:sweep:queued-update]", error);
    else counts.expiredQueued += 1;
  }

  // 2) Settle stranded in-flight rows (both runtimes — the bridge reaper only
  //    runs while a bridge polls). updated_at is trigger-maintained, so a live
  //    turn is never this stale.
  const { data: strandedUsers, error: userErr } = await admin
    .from("canvas_assistant_message")
    .update({ status: "error" })
    .eq("user_id", input.userId)
    .eq("thread_id", input.threadId)
    .eq("role", "user")
    .eq("status", "running")
    .lt("updated_at", strandedCutoff)
    .select("id");
  if (userErr) console.error("[assistant:sweep:stranded-user]", userErr);
  counts.strandedUsers = (strandedUsers ?? []).length;

  const { data: strandedAssistants, error: assistantErr } = await admin
    .from("canvas_assistant_message")
    .update({ status: "error", error: STRANDED_MESSAGE })
    .eq("user_id", input.userId)
    .eq("thread_id", input.threadId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .lt("updated_at", strandedCutoff)
    .select("id");
  if (assistantErr) console.error("[assistant:sweep:stranded-assistant]", assistantErr);
  counts.strandedAssistants = (strandedAssistants ?? []).length;

  return counts;
}
