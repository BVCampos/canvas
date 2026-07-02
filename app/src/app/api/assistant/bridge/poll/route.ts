// POST /api/assistant/bridge/poll?token=<mcp token>  (see ADR-0006)
//
// The local canvas-agent bridge calls this on a short interval. It claims the
// user's queued chatbox prompts (atomically flips queued -> running) and returns
// them, each with its agent session id so the bridge can `resume`
// that thread's conversation instead of starting cold (the session is per-thread
// since ADR-0007). Writes go through the service-role client after the MCP token
// resolves to a user + workspace.

import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeToken, extractBridgeToken } from "@/lib/canvas/assistant/bridge-auth";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { logUsage } from "@/lib/usage/log";

export const runtime = "nodejs";

const MAX_CLAIM = 5;

// A turn that hasn't been touched in this long is treated as dead. The bridge
// flushes a delta every ~600ms during a live stream and every update bumps
// `updated_at` (touch trigger), so a live turn is never this stale — only a
// crashed/slept/Ctrl-C'd bridge leaves a row untouched this long.
const STALE_MS = 120_000;

const STALE_MESSAGE =
  "The local assistant stopped responding. Send your message again to retry.";

export async function POST(request: NextRequest) {
  const token = extractBridgeToken(request);
  const auth = await resolveBridgeToken(token);
  if (!auth.ok) {
    logUsage({
      event: "assistant.bridge.auth_fail",
      surface: "api",
      status: "denied",
      props: { reason: auth.reason },
    });
    return NextResponse.json({ ok: false, error: auth.reason }, { status: auth.status });
  }
  const { admin, userId, workspaceId } = auth;

  // Generous ceiling; a 2s poll is ~30/min. Trips only on a runaway client.
  if (!(await rateLimitOk(admin, `assistant:poll:${token}`, 120, 60))) {
    logUsage({
      event: "assistant.bridge.rate_limited",
      surface: "api",
      user_id: userId,
      workspace_id: workspaceId,
      status: "denied",
    });
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  // Heartbeat: record that this user's bridge is alive so the chatbox can show
  // a presence indicator (0044) without waiting for an in-flight turn to stall.
  // Best-effort — a presence write must never fail the poll.
  const presence: Record<string, string> = {
    user_id: userId,
    workspace_id: workspaceId,
    last_seen_at: new Date().toISOString(),
  };
  const bridgeVersion = request.headers.get("x-bridge-version");
  const agentProvider = request.headers.get("x-agent-provider");
  if (bridgeVersion) presence.bridge_version = bridgeVersion;
  if (agentProvider) presence.agent_provider = agentProvider;

  await admin
    .from("canvas_assistant_bridge_presence")
    .upsert(presence, { onConflict: "user_id" })
    .then(({ error }) => {
      if (error) console.error("[assistant:poll:presence]", error);
    });

  // Best-effort maintenance: error out turns whose bridge died mid-flight so
  // they don't hang forever (the only other escape today is "Clear").
  await reapStaleTurns(admin, userId);

  // Find the oldest queued prompts for this user.
  const { data: queued, error: qErr } = await admin
    .from("canvas_assistant_message")
    .select("id, deck_id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("role", "user")
    .eq("status", "queued")
    .eq("execution_runtime", "bridge")
    .order("created_at", { ascending: true })
    .limit(MAX_CLAIM);

  if (qErr) {
    console.error("[assistant:poll:select]", qErr);
    return NextResponse.json({ ok: false, error: "select_failed" }, { status: 500 });
  }
  if (!queued || queued.length === 0) {
    return NextResponse.json({ ok: true, messages: [] });
  }

  // Atomic claim: only rows still 'queued' flip to 'running'. If two bridges
  // race, each gets a disjoint subset.
  const ids = queued.map((r) => r.id as string);
  const { data: claimed, error: cErr } = await admin
    .from("canvas_assistant_message")
    .update({ status: "running" })
    .in("id", ids)
    .eq("status", "queued")
    .eq("execution_runtime", "bridge")
    .select("id, deck_id, thread_id, content");

  if (cErr) {
    console.error("[assistant:poll:claim]", cErr);
    return NextResponse.json({ ok: false, error: "claim_failed" }, { status: 500 });
  }

  // Attach the resume pointer — each thread carries its own session id (ADR-0007),
  // so the bridge resumes that thread's conversation rather than the deck's latest.
  // Fetch every claimed prompt's thread in ONE round-trip (`.in(threadIds)`) and
  // map session ids locally: a per-message maybeSingle would be an N+1, and the
  // claim caps N at MAX_CLAIM so the id set is tiny.
  const claimedRows = claimed ?? [];
  const threadIds = Array.from(
    new Set(claimedRows.map((row) => row.thread_id as string)),
  );
  const sessionByThreadId = new Map<string, string | null>();
  if (threadIds.length > 0) {
    const { data: threads } = await admin
      .from("canvas_assistant_thread")
      .select("id, claude_session_id")
      .in("id", threadIds);
    for (const thread of threads ?? []) {
      sessionByThreadId.set(
        thread.id as string,
        (thread.claude_session_id as string | null) ?? null,
      );
    }
  }

  const messages = claimedRows.map((row) => ({
    id: row.id as string,
    deck_id: row.deck_id as string,
    thread_id: row.thread_id as string,
    content: row.content as string,
    resume_session_id: sessionByThreadId.get(row.thread_id as string) ?? null,
  }));

  return NextResponse.json({ ok: true, messages });
}

// Recover turns abandoned by a dead bridge. Each write is best-effort: a
// reaper hiccup must never fail the poll (it's maintenance, not the request).
async function reapStaleTurns(admin: SupabaseClient, userId: string) {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();

  // 1) Dead streams: an assistant row stuck 'streaming' past the cutoff. A live
  //    stream flushes a delta every ~600ms, so it's never this stale — only a
  //    crashed bridge leaves a streaming row untouched this long.
  const { error: streamErr } = await admin
    .from("canvas_assistant_message")
    .update({ status: "error", error: STALE_MESSAGE })
    .eq("user_id", userId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .eq("execution_runtime", "bridge")
    .lt("updated_at", cutoff);
  if (streamErr) console.error("[assistant:poll:reap-stream]", streamErr);

  // 2) Abandoned prompts: a 'running' user row stays running (and thus stale)
  //    for the whole turn, so we can't reap on staleness alone — a live long
  //    turn would be a false positive. Guard by requiring NO fresh paired
  //    assistant row (a live or just-finished turn touches one within the
  //    window). N is tiny (MAX_CLAIM=5), so a per-row check is fine.
  const { data: stuckUsers, error: userSelErr } = await admin
    .from("canvas_assistant_message")
    .select("id, thread_id")
    .eq("user_id", userId)
    .eq("role", "user")
    .eq("status", "running")
    .eq("execution_runtime", "bridge")
    .lt("updated_at", cutoff);
  if (userSelErr) {
    console.error("[assistant:poll:reap-user-select]", userSelErr);
    return;
  }

  for (const row of stuckUsers ?? []) {
    // Scope the freshness probe to the stuck prompt's THREAD, not its deck
    // (I2): post-ADR-0007 a deck holds many threads, so a deck-scoped probe
    // would see a sibling thread's fresh assistant row and never reap a
    // genuinely-dead prompt — it would hang "working…" forever.
    const { data: fresh, error: freshErr } = await admin
      .from("canvas_assistant_message")
      .select("id")
      .eq("user_id", userId)
      .eq("thread_id", row.thread_id as string)
      .eq("role", "assistant")
      .gte("updated_at", cutoff)
      .limit(1)
      .maybeSingle();
    if (freshErr) {
      console.error("[assistant:poll:reap-user-fresh]", freshErr);
      continue;
    }
    if (fresh) continue; // live or just-finished turn — leave it alone.

    const { error: updErr } = await admin
      .from("canvas_assistant_message")
      .update({ status: "error", error: STALE_MESSAGE })
      .eq("id", row.id as string)
      // Guard the TOCTOU window between the freshness probe above and this
      // write: only reap a row that is STILL 'running'. A concurrent
      // handleFinish that flipped it to 'complete' must not be clobbered.
      .eq("status", "running");
    if (updErr) console.error("[assistant:poll:reap-user-update]", updErr);
  }
}
