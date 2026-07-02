import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { getOpenRouterCredential } from "@/lib/canvas/assistant/openrouter-config";
import { CredentialDecryptError } from "@/lib/security/credential-crypto";
import { runOpenRouterTurn } from "@/lib/canvas/assistant/openrouter-runner";
import { logUsage } from "@/lib/usage/log";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BODY_BYTES = 10_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIsSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!requestIsSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: "bad_origin" }, { status: 403 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }

  let body: { user_message_id?: unknown };
  try {
    body = (await request.json()) as { user_message_id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const userMessageId = body.user_message_id;
  if (typeof userMessageId !== "string" || !UUID_RE.test(userMessageId)) {
    return NextResponse.json({ ok: false, error: "bad_field" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  // RLS is the first ownership/membership gate. The service-role claim below is
  // then re-scoped to the same id + user + runtime + queued state.
  const { data: owned, error: ownedError } = await supabase
    .from("canvas_assistant_message")
    .select(
      "id, deck_id, workspace_id, thread_id, role, status, execution_runtime",
    )
    .eq("id", userMessageId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownedError || !owned || owned.role !== "user") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (owned.execution_runtime !== "openrouter") {
    return NextResponse.json({ ok: false, error: "wrong_runtime" }, { status: 409 });
  }
  if (["complete", "error", "canceled"].includes(owned.status as string)) {
    return NextResponse.json({ ok: true, status: owned.status });
  }
  if (owned.status === "running") {
    return NextResponse.json({ ok: true, status: "already_running" }, { status: 202 });
  }

  const admin = createAdminClient();
  if (!(await rateLimitOk(admin, `assistant:openrouter:${user.id}`, 30, 60))) {
    const message =
      "Too many OpenRouter turns were started at once. Wait a moment and retry.";
    const { data: rejected } = await admin
      .from("canvas_assistant_message")
      .update({ status: "error" })
      .eq("id", userMessageId)
      .eq("user_id", user.id)
      .eq("status", "queued")
      .eq("execution_runtime", "openrouter")
      .select("id")
      .maybeSingle();
    if (rejected) {
      await admin.from("canvas_assistant_message").insert({
        deck_id: owned.deck_id,
        workspace_id: owned.workspace_id,
        user_id: user.id,
        thread_id: owned.thread_id,
        role: "assistant",
        content: "",
        status: "error",
        error: message,
        execution_runtime: "openrouter",
      });
    }
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const { data: claimed, error: claimError } = await admin
    .from("canvas_assistant_message")
    .update({ status: "running" })
    .eq("id", userMessageId)
    .eq("user_id", user.id)
    .eq("role", "user")
    .eq("status", "queued")
    .eq("execution_runtime", "openrouter")
    .select("id, deck_id, workspace_id, thread_id")
    .maybeSingle();
  if (claimError) {
    console.error("[openrouter:claim]", claimError);
    return NextResponse.json({ ok: false, error: "claim_failed" }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ ok: true, status: "already_claimed" }, { status: 202 });
  }

  const { data: assistant, error: assistantError } = await admin
    .from("canvas_assistant_message")
    .insert({
      deck_id: claimed.deck_id,
      workspace_id: claimed.workspace_id,
      user_id: user.id,
      thread_id: claimed.thread_id,
      role: "assistant",
      content: "",
      status: "streaming",
      execution_runtime: "openrouter",
    })
    .select("id")
    .single();
  if (assistantError || !assistant) {
    console.error("[openrouter:assistant-row]", assistantError);
    await admin
      .from("canvas_assistant_message")
      .update({ status: "error" })
      .eq("id", userMessageId)
      .eq("status", "running");
    return NextResponse.json({ ok: false, error: "start_failed" }, { status: 500 });
  }

  let credential: Awaited<ReturnType<typeof getOpenRouterCredential>>;
  // Distinguish "no key configured" from "a key is saved but can't be decrypted"
  // (rotated/changed server key, corrupt row) so the member gets an actionable
  // message instead of being told to connect a key they already connected.
  let undecryptable = false;
  try {
    // Personal key first, else the workspace-shared key (ADR-0011).
    credential = await getOpenRouterCredential(
      user.id,
      claimed.workspace_id as string,
      admin,
    );
  } catch (error) {
    console.error("[openrouter:credential]", error);
    credential = null;
    undecryptable = error instanceof CredentialDecryptError;
  }
  if (!credential) {
    const message = undecryptable
      ? "Your saved OpenRouter key couldn't be decrypted — it may have been stored under a different server key. Re-enter it in Connections."
      : "OpenRouter is not connected. Add a personal API key in Connections, or ask a workspace admin to set a shared key.";
    await Promise.all([
      admin
        .from("canvas_assistant_message")
        .update({ status: "error", error: message })
        .eq("id", assistant.id),
      admin
        .from("canvas_assistant_message")
        .update({ status: "error" })
        .eq("id", userMessageId),
    ]);
    return NextResponse.json(
      { ok: false, error: undecryptable ? "key_undecryptable" : "not_configured" },
      { status: 409 },
    );
  }

  logUsage({
    event: "assistant.openrouter.start",
    surface: "api",
    user_id: user.id,
    workspace_id: claimed.workspace_id as string,
    deck_id: claimed.deck_id as string,
    status: "ok",
    props: { model_id: credential.modelId, key_source: credential.source },
  });

  const result = await runOpenRouterTurn({
    admin,
    userMessageId,
    assistantMessageId: assistant.id as string,
    userId: user.id,
    workspaceId: claimed.workspace_id as string,
    deckId: claimed.deck_id as string,
    threadId: claimed.thread_id as string,
    apiKey: credential.apiKey,
    modelId: credential.modelId,
  });

  // Stamp the diagnostics on the event itself: prod errors used to log
  // props {}, leaving the (deletable) message row as the only witness to what
  // failed — provider status, model, and the round it died in now survive
  // thread deletion.
  logUsage({
    event: `assistant.openrouter.${result.status}`,
    surface: "api",
    user_id: user.id,
    workspace_id: claimed.workspace_id as string,
    deck_id: claimed.deck_id as string,
    status: result.status === "error" ? "error" : "ok",
    props:
      result.status === "complete"
        ? {
            model_id: result.model,
            ...(result.roundLimited ? { round_limited: true } : {}),
          }
        : result.status === "error"
          ? {
              model_id: result.modelId,
              provider_status: result.providerStatus,
              round: result.round,
              message: result.error,
            }
          : undefined,
  });

  return NextResponse.json({ ok: result.status !== "error", ...result });
}
