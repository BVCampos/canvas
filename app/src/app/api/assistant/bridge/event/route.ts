// POST /api/assistant/bridge/event?token=<mcp token>  (see ADR-0006)
//
// The local bridge reports the progress of an agent turn here. The body is
// discriminated by `type`:
//
//   start  { user_message_id, deck_id }                  -> opens an assistant row (streaming), returns its id
//   delta  { assistant_message_id, content }             -> updates the assistant row's content (cumulative snapshot)
//   finish { assistant_message_id, user_message_id, content?, session_id? }
//                                                          -> marks assistant complete, user complete, and stores
//                                                             session_id on the THREAD as its resume pointer (ADR-0007)
//   error  { user_message_id, assistant_message_id?, error }
//                                                          -> marks the turn errored
//   canceled { user_message_id, assistant_message_id?, content? }
//                                                          -> marks the turn STOPPED (user Stop),
//                                                             keeping the partial content (ADR-0008)
//
// Every referenced row is re-checked against the token's user before it is
// touched, so a token can only ever mutate its own thread.

import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeToken, extractBridgeToken } from "@/lib/canvas/assistant/bridge-auth";
import {
  parseBridgeEvent,
  type BridgeStartEvent,
  type BridgeDeltaEvent,
  type BridgeFinishEvent,
  type BridgeErrorEvent,
  type BridgeCanceledEvent,
} from "@/lib/canvas/assistant/bridge-events";
import { logUsage } from "@/lib/usage/log";

export const runtime = "nodejs";

const MAX_CONTENT = 200_000;
// Reject obviously-oversized bodies before reading them. MAX_CONTENT is the
// per-field cap; the body cap is looser to allow envelope overhead.
const MAX_BODY_BYTES = 300_000;

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

  // Cheap first gate from Content-Length, before we read/parse the body.
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  // Parse + narrow the stringly-typed wire body to a BridgeEvent union. Pure
  // shape validation (unknown type -> 400 unknown_type; delta non-string content
  // -> 400 bad_field) is decided here, identical to the prior per-handler checks;
  // the DB ownership gates (404 not_found) still live in the handlers.
  const parsed = parseBridgeEvent(body);
  if (parsed.kind === "reject") {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: parsed.status });
  }
  const event = parsed.event;
  try {
    switch (event.type) {
      case "start":
        return await handleStart(admin, userId, workspaceId, event);
      case "delta":
        return await handleDelta(admin, userId, event);
      case "finish":
        return await handleFinish(admin, userId, workspaceId, event);
      case "error":
        return await handleError(admin, userId, workspaceId, event);
      case "canceled":
        return await handleCanceled(admin, userId, workspaceId, event);
    }
  } catch (err) {
    console.error("[assistant:event]", event.type, err);
    return NextResponse.json({ ok: false, error: "event_failed" }, { status: 500 });
  }
}

// Fetch a message row only if it belongs to this token's user (ownership gate).
async function ownRow(
  admin: SupabaseClient,
  userId: string,
  id: unknown,
): Promise<{
  id: string;
  deck_id: string;
  workspace_id: string;
  thread_id: string;
} | null> {
  if (typeof id !== "string" || !id) return null;
  const { data } = await admin
    .from("canvas_assistant_message")
    .select("id, deck_id, workspace_id, user_id, thread_id, execution_runtime")
    .eq("id", id)
    .maybeSingle();
  if (
    !data ||
    data.user_id !== userId ||
    (data.execution_runtime != null && data.execution_runtime !== "bridge")
  ) return null;
  return {
    id: data.id as string,
    deck_id: data.deck_id as string,
    workspace_id: data.workspace_id as string,
    thread_id: data.thread_id as string,
  };
}

function clamp(v: unknown): string {
  return typeof v === "string" ? v.slice(0, MAX_CONTENT) : "";
}

async function handleStart(
  admin: SupabaseClient,
  userId: string,
  workspaceId: string,
  event: BridgeStartEvent,
) {
  const userMsg = await ownRow(admin, userId, event.user_message_id);
  if (!userMsg) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const { data, error } = await admin
    .from("canvas_assistant_message")
    .insert({
      deck_id: userMsg.deck_id,
      workspace_id: workspaceId,
      user_id: userId,
      // The reply inherits the prompt's thread — authoritative from the row, so
      // the bridge can't misroute it by passing a stray thread_id.
      thread_id: userMsg.thread_id,
      role: "assistant",
      content: "",
      status: "streaming",
      execution_runtime: "bridge",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[assistant:event:start]", error);
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
  }
  logUsage({
    event: "assistant.turn.start",
    surface: "api",
    user_id: userId,
    workspace_id: workspaceId,
    deck_id: userMsg.deck_id,
    status: "ok",
  });
  return NextResponse.json({ ok: true, assistant_message_id: data.id });
}

async function handleDelta(
  admin: SupabaseClient,
  userId: string,
  event: BridgeDeltaEvent,
) {
  // A delta carries a cumulative content snapshot. The non-string-content guard
  // (which would clamp() to "" and wipe the row) now lives in parseBridgeEvent —
  // a non-string content is rejected 400 bad_field before reaching here, so
  // event.content is always a string at this point.
  const row = await ownRow(admin, userId, event.assistant_message_id);
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const { error } = await admin
    .from("canvas_assistant_message")
    .update({ content: clamp(event.content), status: "streaming" })
    .eq("id", row.id);
  if (error) {
    console.error("[assistant:event:delta]", error);
    return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

async function handleFinish(
  admin: SupabaseClient,
  userId: string,
  workspaceId: string,
  event: BridgeFinishEvent,
) {
  const assistant = await ownRow(admin, userId, event.assistant_message_id);
  if (!assistant) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const patch: Record<string, unknown> = { status: "complete" };
  if (typeof event.content === "string") patch.content = clamp(event.content);
  // Idempotency guard: a late finish must not resurrect a turn the reaper, an
  // error, or a user STOP (ADR-0008) already closed out — terminal states are
  // mutually exclusive, first one wins.
  const { error: aErr } = await admin
    .from("canvas_assistant_message")
    .update(patch)
    .eq("id", assistant.id)
    .neq("status", "error")
    .neq("status", "canceled");
  if (aErr) {
    console.error("[assistant:event:finish]", aErr);
    return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
  }

  // Persist the resume pointer on the THREAD (ADR-0007): the next prompt in this
  // thread resumes here. Best-effort — a lost pointer only costs a cold restart,
  // it must not fail the finish (which would strand the row "working…").
  if (typeof event.session_id === "string" && event.session_id) {
    const { error: sErr } = await admin
      .from("canvas_assistant_thread")
      .update({ claude_session_id: event.session_id })
      .eq("id", assistant.thread_id);
    if (sErr) console.error("[assistant:event:finish:session]", sErr);
  }

  // Close out the prompt that triggered this turn (same idempotency guard).
  // Best-effort, like the session-pointer write above: the assistant row (the
  // actual answer) is already committed, so a failed prompt close-out must not
  // 500 the finish — that would leave the answer saved but the turn reported
  // as failed. Log and continue.
  const userMsg = await ownRow(admin, userId, event.user_message_id);
  if (userMsg) {
    const { error: uErr } = await admin
      .from("canvas_assistant_message")
      .update({ status: "complete" })
      .eq("id", userMsg.id)
      .neq("status", "error")
      .neq("status", "canceled");
    if (uErr) console.error("[assistant:event:finish:user]", uErr);
  }

  logUsage({
    event: "assistant.turn.finish",
    surface: "api",
    user_id: userId,
    workspace_id: workspaceId,
    deck_id: assistant.deck_id,
    status: "ok",
  });
  return NextResponse.json({ ok: true });
}

async function handleError(
  admin: SupabaseClient,
  userId: string,
  workspaceId: string,
  event: BridgeErrorEvent,
) {
  const errText = clamp(event.error).slice(0, 2000) || "The local assistant hit an error.";

  const userMsg = await ownRow(admin, userId, event.user_message_id);
  const assistant = await ownRow(admin, userId, event.assistant_message_id);

  // Track whether we touched any row the caller actually owns. A resolved owned
  // row counts even if its guarded update no-ops on an already-terminal status
  // (that's idempotency, not "not found"). Only a total miss — neither id maps
  // to an owned row — is reported 404 so the bridge knows the error wasn't
  // recorded, instead of being told it succeeded.
  const matched = Boolean(assistant) || Boolean(userMsg);

  if (assistant) {
    // Idempotency guard, symmetric with handleFinish's: a late/retried error
    // event must not resurrect a turn the bridge or reaper already settled as
    // complete (the bridge retries error POSTs), nor override a user STOP
    // (ADR-0008). (I1)
    const { error } = await admin
      .from("canvas_assistant_message")
      .update({ status: "error", error: errText })
      .eq("id", assistant.id)
      .neq("status", "complete")
      .neq("status", "canceled");
    if (error) {
      console.error("[assistant:event:error]", error);
      return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
    }
  } else if (userMsg) {
    // No assistant row was opened — surface the error as its own row.
    const { error } = await admin.from("canvas_assistant_message").insert({
      deck_id: userMsg.deck_id,
      workspace_id: workspaceId,
      user_id: userId,
      thread_id: userMsg.thread_id,
      role: "assistant",
      content: "",
      status: "error",
      error: errText,
      execution_runtime: "bridge",
    });
    if (error) {
      console.error("[assistant:event:error]", error);
      return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
    }
  }

  if (userMsg) {
    // Same guard for the prompt row: don't flip a completed or canceled turn
    // back to error.
    const { error } = await admin
      .from("canvas_assistant_message")
      .update({ status: "error" })
      .eq("id", userMsg.id)
      .neq("status", "complete")
      .neq("status", "canceled");
    if (error) {
      console.error("[assistant:event:error]", error);
      return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
    }
  }

  if (!matched) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  logUsage({
    event: "assistant.turn.error",
    surface: "api",
    user_id: userId,
    workspace_id: workspaceId,
    deck_id: (assistant ?? userMsg)?.deck_id ?? null,
    status: "error",
  });
  return NextResponse.json({ ok: true });
}

// The bridge reports a STOPPED turn (ADR-0008): the user hit Stop, the bridge's
// in-turn cancel poll saw it and aborted the running `claude -p`. We settle both
// rows to the terminal 'canceled' status, KEEPING whatever partial content
// streamed so far (so the chatbox shows what Claude produced before the stop,
// labelled "Stopped" — not a red error). Structure mirrors handleError: settle
// the assistant row if present, the prompt row always, 404 only on a total miss.
async function handleCanceled(
  admin: SupabaseClient,
  userId: string,
  workspaceId: string,
  event: BridgeCanceledEvent,
) {
  const userMsg = await ownRow(admin, userId, event.user_message_id);
  const assistant = await ownRow(admin, userId, event.assistant_message_id);
  const matched = Boolean(assistant) || Boolean(userMsg);

  if (assistant) {
    // Keep the partial reply when the bridge sent it; leave the row's content
    // untouched otherwise (a stop before any text streamed). First terminal
    // wins: a turn already complete/error (or canceled) is left as-is.
    const patch: Record<string, unknown> = { status: "canceled" };
    if (typeof event.content === "string") patch.content = clamp(event.content);
    const { error } = await admin
      .from("canvas_assistant_message")
      .update(patch)
      .eq("id", assistant.id)
      .neq("status", "complete")
      .neq("status", "error")
      .neq("status", "canceled");
    if (error) {
      console.error("[assistant:event:canceled]", error);
      return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
    }
  }

  if (userMsg) {
    const { error } = await admin
      .from("canvas_assistant_message")
      .update({ status: "canceled" })
      .eq("id", userMsg.id)
      .neq("status", "complete")
      .neq("status", "error")
      .neq("status", "canceled");
    if (error) {
      console.error("[assistant:event:canceled]", error);
      return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
    }
  }

  if (!matched) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  logUsage({
    event: "assistant.turn.canceled",
    surface: "api",
    user_id: userId,
    workspace_id: workspaceId,
    deck_id: (assistant ?? userMsg)?.deck_id ?? null,
    status: "ok",
  });
  return NextResponse.json({ ok: true });
}
