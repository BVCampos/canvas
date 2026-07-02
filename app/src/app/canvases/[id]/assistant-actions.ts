"use server";

// Server actions behind the in-app assistant chatbox (see ADR-0006, ADR-0007).
//
// These only touch the queue + threads: the user enqueues a prompt with an
// explicit runtime. The local `canvas-agent` bridge or the personal OpenRouter
// route claims only its own rows and streams the reply back through Realtime.
//
// A conversation is a `canvas_assistant_thread`; every prompt/reply carries its
// thread_id. The first prompt of a new conversation creates the thread (and
// titles it from that prompt); "delete conversation" drops the thread, whose
// messages cascade with it.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logUsage } from "@/lib/usage/log";
import {
  getOpenRouterConfigSummary,
  type AssistantRuntime,
} from "@/lib/canvas/assistant/openrouter-config";
import { sweepStaleAssistantRows } from "@/lib/canvas/assistant/turn-sweeper";
import { describeComposedPrompt } from "./assistant-prompt";

const MAX_PROMPT = 8000;
const TITLE_LEN = 80;
// The bridge upserts presence every ~2.5s while it runs; treat 3 missed beats
// (8s) as offline — mirrors the chatbox's bridgeOnline threshold so Stop's
// online/offline decision matches what the presence dot shows the user.
const BRIDGE_ONLINE_MS = 8000;

export type SendResult =
  | { ok: true; id: string; threadId: string }
  | { ok: false; error: string };

export async function sendAssistantMessage(
  deckId: string,
  // null on the first message of a new conversation — we create the thread here
  // and title it from this prompt. Otherwise the prompt joins an existing thread.
  threadId: string | null,
  text: string,
  runtime: AssistantRuntime = "bridge",
): Promise<SendResult> {
  const prompt = text.trim();
  if (!prompt) return { ok: false, error: "empty" };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: "too_long" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const executionRuntime: AssistantRuntime =
    runtime === "openrouter" ? "openrouter" : "bridge";

  // RLS gates this read to decks the user can see; it also gives us the
  // workspace_id to stamp on the thread + message (and to resolve a shared key).
  const { data: deck, error: dErr } = await supabase
    .from("canvas_deck")
    .select("id, workspace_id")
    .eq("id", deckId)
    .maybeSingle();
  if (dErr || !deck) return { ok: false, error: "deck_not_found" };

  if (executionRuntime === "openrouter") {
    try {
      // Personal key OR a workspace-shared key (ADR-0011) makes OpenRouter usable.
      const config = await getOpenRouterConfigSummary(
        user.id,
        deck.workspace_id as string,
      );
      if (!config.configured || !config.encryptionReady) {
        return { ok: false, error: "openrouter_not_configured" };
      }
    } catch (error) {
      console.error("[sendAssistantMessage:openrouter-config]", error);
      return { ok: false, error: "openrouter_not_configured" };
    }
  }

  // First message of a new conversation: create the thread, titled from the
  // prompt. RLS re-checks ownership + deck-readability on insert.
  let resolvedThreadId = threadId;
  if (!resolvedThreadId) {
    const { data: thread, error: tErr } = await supabase
      .from("canvas_assistant_thread")
      .insert({
        deck_id: deck.id,
        workspace_id: deck.workspace_id,
        user_id: user.id,
        // Title from the instruction the user typed, not the folded context
        // preamble (slide_id, HTML anchor, tool hint) — describeComposedPrompt is
        // the inverse of the composer's builders. The message content stays full,
        // so both runtimes still read the context; only the thread name is clean.
        title: describeComposedPrompt(prompt).instruction.slice(0, TITLE_LEN),
      })
      .select("id")
      .single();
    if (tErr || !thread) {
      console.error("[sendAssistantMessage:thread]", tErr);
      return { ok: false, error: "thread_create_failed" };
    }
    resolvedThreadId = thread.id as string;
  }

  const { data, error } = await supabase
    .from("canvas_assistant_message")
    .insert({
      deck_id: deck.id,
      workspace_id: deck.workspace_id,
      user_id: user.id,
      thread_id: resolvedThreadId,
      role: "user",
      content: prompt,
      status: "queued",
      execution_runtime: executionRuntime,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[sendAssistantMessage]", error);
    // Return a stable code, never the raw Postgres message (which can leak
    // schema details to the client). The UI maps codes to friendly text.
    return { ok: false, error: "insert_failed" };
  }

  logUsage({
    event: "assistant.prompt",
    surface: "action",
    user_id: user.id,
    workspace_id: deck.workspace_id as string,
    deck_id: deck.id as string,
    status: "ok",
    props: { len: prompt.length, runtime: executionRuntime },
  });

  return { ok: true, id: data.id as string, threadId: resolvedThreadId };
}

// Expire this thread's ghost rows: prompts queued into a dead runtime and
// in-flight rows stranded by a mid-turn restart (turn-sweeper.ts has the full
// story). Called by the panel when it hydrates a thread — the exact moment the
// user would otherwise stare at a stuck spinner — and the resulting row
// updates flow back through the panel's existing Realtime subscription.
// Best-effort maintenance: failures log server-side and never surface.
export async function sweepAssistantTurns(
  deckId: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  // Ownership gate (RLS-scoped read), mirroring cancelAssistantTurn: the
  // thread must be the caller's own, on this deck.
  const { data: thread } = await supabase
    .from("canvas_assistant_thread")
    .select("id")
    .eq("id", threadId)
    .eq("deck_id", deckId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!thread) return { ok: false };

  try {
    await sweepStaleAssistantRows(createAdminClient(), {
      userId: user.id,
      threadId,
    });
  } catch (error) {
    console.error("[sweepAssistantTurns]", error);
    return { ok: false };
  }
  return { ok: true };
}

// Delete one conversation. Its messages cascade with the thread row (0042 FK).
// Replaces 0041's clear-everything path — scoped to a single thread now.
export async function deleteAssistantThread(
  deckId: string,
  threadId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const { error } = await supabase
    .from("canvas_assistant_thread")
    .delete()
    .eq("id", threadId)
    .eq("deck_id", deckId)
    .eq("user_id", user.id);

  if (error) {
    console.error("[deleteAssistantThread]", error);
    // Stable code, not the raw Postgres message (see sendAssistantMessage).
    return { ok: false, error: "delete_failed" };
  }
  return { ok: true };
}

// Stop the in-flight turn in a thread (ADR-0008) — the chatbox's Stop button.
//
// In-flight rows have no authenticated UPDATE policy (they're mutated only by
// the service-role path, like the bridge), so after verifying the user owns the
// thread we do the cancel writes through the admin client, re-scoped to this
// thread + user. Two shapes:
//   • queued prompts never started — flip them straight to the terminal
//     'canceled' (no bridge turn to interrupt).
//   • a running local turn is best stopped by the bridge (it aborts its provider
//     and keeps partial output). A server-side OpenRouter turn settles immediately
//     and its watcher aborts the API request. A dead local bridge is settled by
//     this action too, so Stop is never a silent no-op.
export async function cancelAssistantTurn(
  deckId: string,
  threadId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // Ownership gate: the thread must be the user's own, on this deck (RLS-scoped).
  const { data: thread, error: tErr } = await supabase
    .from("canvas_assistant_thread")
    .select("id, workspace_id")
    .eq("id", threadId)
    .eq("deck_id", deckId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (tErr || !thread) return { ok: false, error: "thread_not_found" };

  const admin = createAdminClient();

  // Queued prompts: never started — settle them outright.
  const { error: qErr } = await admin
    .from("canvas_assistant_message")
    .update({ status: "canceled" })
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .eq("role", "user")
    .eq("status", "queued");
  if (qErr) console.error("[cancelAssistantTurn:queued]", qErr);

  const { data: runningRows, error: runningError } = await admin
    .from("canvas_assistant_message")
    .select("execution_runtime")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .eq("role", "user")
    .eq("status", "running");
  if (runningError) {
    console.error("[cancelAssistantTurn:running]", runningError);
    return { ok: false, error: "cancel_failed" };
  }
  const hasOpenRouterTurn = (runningRows ?? []).some(
    (row) => row.execution_runtime === "openrouter",
  );
  const hasBridgeTurn = (runningRows ?? []).some(
    (row) => row.execution_runtime !== "openrouter",
  );

  // OpenRouter runs in this server process. Settle its rows immediately so Stop
  // is responsive even if the worker died; the runner's cancel watcher sees the
  // terminal prompt and aborts the provider stream without being able to write
  // over these guarded terminal rows.
  if (hasOpenRouterTurn) {
    const canceledAt = new Date().toISOString();
    const { error: orUserError } = await admin
      .from("canvas_assistant_message")
      .update({ status: "canceled", cancel_requested_at: canceledAt })
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .eq("role", "user")
      .eq("status", "running")
      .eq("execution_runtime", "openrouter");
    if (orUserError) {
      console.error("[cancelAssistantTurn:openrouter-user]", orUserError);
      return { ok: false, error: "cancel_failed" };
    }
    const { error: orAssistantError } = await admin
      .from("canvas_assistant_message")
      .update({ status: "canceled" })
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .eq("role", "assistant")
      .eq("status", "streaming")
      .eq("execution_runtime", "openrouter");
    if (orAssistantError) {
      console.error("[cancelAssistantTurn:openrouter-assistant]", orAssistantError);
    }
  }

  // Is the user's local bridge alive? (Same threshold as the chatbox dot.)
  const { data: presence } = await admin
    .from("canvas_assistant_bridge_presence")
    .select("last_seen_at")
    .eq("user_id", user.id)
    .maybeSingle();
  const lastSeen = presence?.last_seen_at
    ? new Date(presence.last_seen_at as string).getTime()
    : 0;
  const bridgeOnline = Date.now() - lastSeen < BRIDGE_ONLINE_MS;

  if (hasBridgeTurn && bridgeOnline) {
    // Request the stop; the bridge's cancel-check poll picks it up, aborts the
    // turn, and reports a `canceled` event that settles the rows.
    const { error: rErr } = await admin
      .from("canvas_assistant_message")
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .eq("role", "user")
      .eq("status", "running")
      .eq("execution_runtime", "bridge");
    if (rErr) {
      console.error("[cancelAssistantTurn:request]", rErr);
      return { ok: false, error: "cancel_failed" };
    }
  } else if (hasBridgeTurn) {
    // No live bridge to interrupt — settle the in-flight rows ourselves, keeping
    // whatever partial reply the streaming row already holds.
    const { error: uErr } = await admin
      .from("canvas_assistant_message")
      .update({ status: "canceled" })
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .eq("role", "user")
      .eq("status", "running")
      .eq("execution_runtime", "bridge");
    if (uErr) console.error("[cancelAssistantTurn:user-offline]", uErr);
    const { error: aErr } = await admin
      .from("canvas_assistant_message")
      .update({ status: "canceled" })
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .eq("role", "assistant")
      .eq("status", "streaming")
      .eq("execution_runtime", "bridge");
    if (aErr) console.error("[cancelAssistantTurn:assistant-offline]", aErr);
  }

  logUsage({
    event: "assistant.cancel",
    surface: "action",
    user_id: user.id,
    workspace_id: thread.workspace_id as string,
    deck_id: deckId,
    status: "ok",
    props: {
      bridge_online: bridgeOnline,
      bridge_turn: hasBridgeTurn,
      openrouter_turn: hasOpenRouterTurn,
    },
  });

  return { ok: true };
}
