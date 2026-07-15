import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ExpectedError,
  isMcpContentResult,
  toolDescriptors,
  tools,
  type AuthContext,
} from "@/lib/canvas/mcp/tools";
import { CHAT_TOOL_DESCRIPTIONS } from "@/lib/canvas/assistant/chat-tool-descriptions";
import { parseOpenRouterModels } from "@/lib/canvas/assistant/openrouter-client";
import { modelAcceptsImageInput } from "@/lib/canvas/assistant/openrouter-catalog";
import {
  ProviderError,
  type ChatToolDescriptor,
  type CompletionDriver,
  type CompletionRound,
  type ImagePart,
  type OpenRouterMessage,
  type TextPart,
} from "@/lib/canvas/assistant/completion-types";
import {
  openAiCompletionDriver,
  openRouterCompletionDriver,
} from "@/lib/canvas/assistant/openai-compat-driver";
import { anthropicCompletionDriver } from "@/lib/canvas/assistant/anthropic-driver";
import type { HostedProvider } from "@/lib/canvas/assistant/hosted-providers";

const MAX_TOOL_ROUNDS = 12;
const MAX_HISTORY_MESSAGES = 48;
const MAX_HISTORY_CHARS = 120_000;
const MAX_TOOL_TEXT_CHARS = 160_000;
const MAX_RENDER_IMAGES = 12;
const CONTENT_FLUSH_MS = 400;
const MAX_CONTENT_CHARS = 200_000;
const MAX_REASONING_CHARS = 200_000;
// One retry per failed completion round. Prod showed OpenRouter alias routing
// flapping 404 seconds after the same alias completed a turn — a single fresh
// attempt converts those from dead turns into completions.
const ROUND_RETRY_DELAY_MS = 750;

// Vision relay: rounds that carry render images run on this model when the
// user's model is text-only. Sending image_url parts to a text-only model
// makes OpenRouter 404 the whole round ("No endpoints found that support
// image input") — deterministically, so nearly every edit turn died once the
// system prompt's render-and-inspect step kicked in. The relay must support
// BOTH image input and tool calling (it may withdraw/revise after looking).
export const VISION_RELAY_MODEL = "minimax/minimax-m3";

const IMAGE_CONSUMED_NOTE =
  "(The rendered image was inspected in the previous assistant message and is no longer attached.)";
const IMAGE_UNDELIVERABLE_NOTE =
  "(The rendered image could not be shown to any available model. Rely on the tool's text output and leave visual verification to the human reviewer.)";

// Note appended when a turn runs out of tool rounds. The partial work is
// settled as a normal reply (proposals made so far stay pending) instead of
// erroring away minutes of progress.
const ROUND_LIMIT_NOTE =
  "\n\n— I hit this turn's tool-call limit before finishing. Reply “continue” and I'll pick up from here.";

// A deck-scoped chat doesn't need workspace navigation/creation, snapshot and
// version-history archaeology (History UI work), lock choreography (the turn
// executes inside one held-open request), comment administration, or
// cross-deck copy (unreachable without list_decks anyway). Each schema rides
// EVERY completion round, so the cut compounds: with the chat-length
// descriptions this takes the fixed per-round prefill from ~15k tokens to a
// fraction (assistant speed discovery 2026-07 #3).
const EXCLUDED_CHAT_TOOLS = new Set([
  "create_deck",
  "list_decks",
  "list_projects",
  "create_project",
  "create_snapshot",
  "list_snapshots",
  "read_snapshot",
  "diff_snapshots",
  "list_slide_versions",
  "read_slide_version",
  "diff_slide_versions",
  "lock_slide",
  "release_slide",
  "resolve_comment",
  "copy_slide",
]);

// Tools that only read — safe to execute concurrently when a round requests
// several of them (read_slide + read_theme is the common pair). Render tools
// stay serial: they contend on the box-wide render gate, which rejects rather
// than queues when saturated.
const PARALLEL_SAFE_CHAT_TOOLS = new Set([
  "get_deck",
  "read_slide",
  "read_theme",
  "read_brand",
  "read_full_deck",
  "list_sources",
  "read_source",
  "list_proposals",
  "get_proposal",
  "list_comments",
]);

// The message-space types (OpenRouterMessage, ToolCall, CompletionRound) and
// ProviderError live in completion-types.ts, shared with the per-provider
// completion drivers.
type ToolCall = CompletionRound["toolCalls"][number];

// The completion call is the only provider-specific step of a turn; everything
// else (rounds, tool execution, persistence, cancel checks) is shared.
const COMPLETION_DRIVERS: Record<HostedProvider, CompletionDriver> = {
  openrouter: openRouterCompletionDriver,
  anthropic: anthropicCompletionDriver,
  openai: openAiCompletionDriver,
};

type TurnInput = {
  admin: SupabaseClient;
  userMessageId: string;
  assistantMessageId: string;
  userId: string;
  workspaceId: string;
  deckId: string;
  threadId: string;
  apiKey: string;
  modelId: string;
  // Which hosted API vendor the key belongs to. Optional for wire compat with
  // pre-BYOK callers; absent means the original OpenRouter path.
  provider?: HostedProvider;
};

export type OpenRouterTurnResult =
  | { status: "complete"; model: string | null; roundLimited?: boolean }
  | { status: "canceled" }
  | {
      status: "error";
      error: string;
      // Diagnostics for the caller's usage-event logging — prod errors used to
      // land with props {}, leaving the message row as the only witness.
      providerStatus: number | null;
      round: number;
      modelId: string;
    };

class TurnCanceledError extends Error {}

export const openRouterTools: ChatToolDescriptor[] = toolDescriptors
  .filter((descriptor) => !EXCLUDED_CHAT_TOOLS.has(descriptor.name))
  .map((descriptor) => ({
    type: "function" as const,
    function: {
      name: descriptor.name,
      description:
        CHAT_TOOL_DESCRIPTIONS[descriptor.name] ?? descriptor.description,
      parameters: descriptor.inputSchema,
    },
  }));

function systemPrompt(deckId: string): string {
  return [
    "You are the agent inside 21x Canvas, a propose-first multiplayer HTML deck editor.",
    `The user is currently working in deck_id ${deckId}. Stay on this deck unless they explicitly ask otherwise.`,
    "Use Canvas tools for facts and changes. Read the relevant slide/theme and pinned sources before editing; never invent current deck state.",
    "Edits must be proposals. Prefer targeted propose_slide_patch changes over full rewrites, explain the rationale, and never claim a proposal is already applied.",
    "After a visual proposal, call render_proposal and inspect the returned image. Only use apply_trusted_proposal if the tool says the explicitly opted-in fast lane is available and the render is visibly correct.",
    "Keep the final reply concise: summarize what you found or proposed and identify anything still awaiting human review.",
  ].join("\n");
}

// The static prefix (tool schemas + system prompt) re-runs every round of every
// turn. Anthropic models cache it only when the request marks a breakpoint;
// OpenRouter forwards cache_control on content parts. Other providers
// (OpenAI-compatible, DeepSeek, GLM) cache implicitly, so they get the plain
// string form.
function buildSystemMessage(modelId: string, deckId: string): OpenRouterMessage {
  const text = systemPrompt(deckId);
  if (modelId.startsWith("anthropic/")) {
    return {
      role: "system",
      content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
    };
  }
  return { role: "system", content: text };
}

// The stored model id may be a comma-separated preference list
// ("z-ai/glm-5.2-20260616, z-ai/glm-5.2"): the first entry is the primary and
// the rest ride OpenRouter's `models` fallback array, so a routing flap on one
// id fails over server-side instead of killing the turn. Delegates to the
// shared parser so the settings validator and the runner agree on "primary".
export function parseModelList(modelId: string): {
  primary: string;
  models: string[];
} {
  const { primary, models } = parseOpenRouterModels(modelId);
  return { primary, models };
}

function safeJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = JSON.stringify({ error: "Tool returned a non-serializable result." });
  }
  if (serialized.length <= MAX_TOOL_TEXT_CHARS) return serialized;
  return `${serialized.slice(0, MAX_TOOL_TEXT_CHARS)}\n…[tool result truncated]`;
}

async function executeToolCall(
  call: ToolCall,
  ctx: AuthContext,
): Promise<{ text: string; images: ImagePart[] }> {
  const fn = tools[call.function.name];
  if (!fn) {
    return {
      text: safeJson({ error: `Unknown Canvas tool: ${call.function.name}` }),
      images: [],
    };
  }
  let args: unknown;
  try {
    args = call.function.arguments.trim()
      ? JSON.parse(call.function.arguments)
      : {};
  } catch {
    return {
      text: safeJson({ error: "Tool arguments were not valid JSON." }),
      images: [],
    };
  }

  try {
    const result = await fn(args, ctx);
    if (!isMcpContentResult(result)) {
      return { text: safeJson(result), images: [] };
    }
    const text = result.__mcpContent
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const imageParts = result.__mcpContent.filter(
      (part): part is { type: "image"; data: string; mimeType: string } =>
        part.type === "image",
    );
    return {
      text: `${text}\n${imageParts.length} rendered image(s) are attached in the next message for visual inspection.`,
      images: imageParts.slice(0, MAX_RENDER_IMAGES).map((part) => ({
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      })),
    };
  } catch (error) {
    if (error instanceof ExpectedError) {
      return { text: safeJson({ error: error.message }), images: [] };
    }
    console.error("[openrouter:tool]", call.function.name, error);
    return {
      text: safeJson({ error: "Canvas could not complete that tool call." }),
      images: [],
    };
  }
}

function carriesImageParts(message: OpenRouterMessage): boolean {
  return (
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url")
  );
}

// Replace every image-carrying message with a plain-text trace. Runs after
// the vision relay consumed the renders (so the next round returns to the
// user's model and stops paying image tokens) or when no model would take
// them (so the turn survives without vision).
function stripImageMessages(messages: OpenRouterMessage[], note: string): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!carriesImageParts(message)) continue;
    const intro = (message.content as Array<TextPart | ImagePart>)
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    messages[i] = { role: "user", content: `${intro}\n${note}`.trim() };
  }
}

function mergeUsage(
  total: Record<string, unknown>,
  next: Record<string, unknown> | null,
): void {
  if (!next) return;
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      total[key] = (typeof total[key] === "number" ? total[key] : 0) + value;
    }
  }
}

async function loadConversation(
  admin: SupabaseClient,
  input: Pick<TurnInput, "threadId" | "userId" | "assistantMessageId">,
): Promise<OpenRouterMessage[]> {
  const { data, error } = await admin
    .from("canvas_assistant_message")
    .select("id, role, content, status, created_at")
    .eq("thread_id", input.threadId)
    .eq("user_id", input.userId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`Assistant history lookup failed: ${error.message}`);

  const candidates = (data ?? [])
    .filter((row) => row.id !== input.assistantMessageId)
    .filter((row) => row.role === "user" || (row.content as string).trim())
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content as string,
    }));

  const kept: Array<{ role: "user" | "assistant"; content: string }> = [];
  let chars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const row = candidates[i];
    if (kept.length >= MAX_HISTORY_MESSAGES) break;
    if (kept.length > 0 && chars + row.content.length > MAX_HISTORY_CHARS) break;
    chars += row.content.length;
    kept.push(row);
  }
  return kept.reverse();
}

function startCancelWatcher(
  admin: SupabaseClient,
  userMessageId: string,
  state: { canceled: boolean; controller: AbortController | null },
): ReturnType<typeof setInterval> {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || state.canceled) return;
    checking = true;
    try {
      const { data } = await admin
        .from("canvas_assistant_message")
        .select("status, cancel_requested_at")
        .eq("id", userMessageId)
        .maybeSingle();
      if (
        data?.cancel_requested_at ||
        data?.status === "canceled"
      ) {
        state.canceled = true;
        state.controller?.abort();
      }
    } finally {
      checking = false;
    }
  }, 900);
  timer.unref?.();
  return timer;
}

async function settleCanceled(input: TurnInput): Promise<void> {
  await Promise.all([
    input.admin
      .from("canvas_assistant_message")
      .update({ status: "canceled" })
      .eq("id", input.assistantMessageId)
      .eq("status", "streaming"),
    input.admin
      .from("canvas_assistant_message")
      .update({ status: "canceled" })
      .eq("id", input.userMessageId)
      .eq("status", "running"),
  ]);
}

// Returns whether THIS call moved the assistant row to `error`. False means
// the row was already terminal — mid-turn that's Stop having settled it
// `canceled` — so the caller should report canceled, not error.
async function settleError(input: TurnInput, message: string): Promise<boolean> {
  const [assistantWrite] = await Promise.all([
    input.admin
      .from("canvas_assistant_message")
      .update({ status: "error", error: message.slice(0, 2000) })
      .eq("id", input.assistantMessageId)
      .eq("status", "streaming")
      .select("id"),
    input.admin
      .from("canvas_assistant_message")
      .update({ status: "error" })
      .eq("id", input.userMessageId)
      .eq("status", "running"),
  ]);
  return ((assistantWrite.data as unknown[] | null) ?? []).length > 0;
}

export async function runOpenRouterTurn(
  input: TurnInput,
): Promise<OpenRouterTurnResult> {
  const cancelState = {
    canceled: false,
    controller: null as AbortController | null,
  };
  const cancelTimer = startCancelWatcher(
    input.admin,
    input.userMessageId,
    cancelState,
  );

  let visibleContent = "";
  let visibleReasoning = "";
  let lastFlush = 0;
  let providerModel: string | null = null;
  let roundNumber = 0;
  const providerUsage: Record<string, unknown> = {};
  const provider: HostedProvider = input.provider ?? "openrouter";
  const completionDriver = COMPLETION_DRIVERS[provider];
  const { primary: primaryModel } = parseModelList(input.modelId);

  // One catalog consultation per turn (the module caches across turns).
  // `null` = unknown: send the images and let the reactive image-404 fallback
  // reroute if the catalog was wrong or silent.
  let primaryImageSupport: boolean | null | undefined;
  const primaryAcceptsImages = async (): Promise<boolean | null> => {
    if (primaryImageSupport === undefined) {
      primaryImageSupport = await modelAcceptsImageInput(primaryModel);
    }
    return primaryImageSupport;
  };

  const flushContent = async (force = false) => {
    if (!visibleContent && !visibleReasoning) return;
    const now = Date.now();
    if (!force && now - lastFlush < CONTENT_FLUSH_MS) return;
    lastFlush = now;
    await input.admin
      .from("canvas_assistant_message")
      .update({
        content: visibleContent.slice(0, MAX_CONTENT_CHARS),
        reasoning: visibleReasoning
          ? visibleReasoning.slice(0, MAX_REASONING_CHARS)
          : null,
      })
      .eq("id", input.assistantMessageId)
      .eq("status", "streaming");
  };

  const settleComplete = async (
    roundLimited: boolean,
  ): Promise<OpenRouterTurnResult> => {
    const { data: settled, error } = await input.admin
      .from("canvas_assistant_message")
      .update({
        content: visibleContent.slice(0, MAX_CONTENT_CHARS),
        reasoning: visibleReasoning
          ? visibleReasoning.slice(0, MAX_REASONING_CHARS)
          : null,
        status: "complete",
        provider_model: providerModel,
        provider_usage:
          Object.keys(providerUsage).length > 0 ? providerUsage : null,
      })
      .eq("id", input.assistantMessageId)
      .eq("status", "streaming")
      .select("id");
    if (error) throw new Error(`Assistant response save failed: ${error.message}`);
    if (!settled || settled.length === 0) {
      // The guarded write matched nothing: the row already left `streaming`
      // under us, and the only writer that does that mid-turn is Stop (the
      // sweeper needs 30 idle minutes a flushing turn can't accumulate). The
      // DB is correctly `canceled` — report that instead of logging a phantom
      // `complete` for a turn the user stopped.
      return { status: "canceled" };
    }
    await input.admin
      .from("canvas_assistant_message")
      .update({ status: "complete" })
      .eq("id", input.userMessageId)
      .eq("status", "running");
    return {
      status: "complete" as const,
      model: providerModel,
      ...(roundLimited ? { roundLimited: true } : {}),
    };
  };

  try {
    const history = await loadConversation(input.admin, input);
    const messages: OpenRouterMessage[] = [
      buildSystemMessage(primaryModel, input.deckId),
      ...history,
    ];

    for (let roundIndex = 0; roundIndex < MAX_TOOL_ROUNDS; roundIndex++) {
      roundNumber = roundIndex + 1;
      if (cancelState.canceled) throw new TurnCanceledError();

      // Vision relay: a round that carries render images cannot run on a
      // text-only primary (OpenRouter 404s it deterministically), so it runs
      // on VISION_RELAY_MODEL instead. The relay inspects with the same tools
      // available; the primary resumes once the images are consumed. The relay
      // (and its catalog consultation) is an OpenRouter routing concept — the
      // native anthropic/openai paths rely on the reactive strip-images
      // fallback below as the safety net.
      const roundHasImages = messages.some(carriesImageParts);
      let roundModelId = input.modelId;
      let relayEngaged = false;
      if (
        provider === "openrouter" &&
        roundHasImages &&
        (await primaryAcceptsImages()) === false
      ) {
        roundModelId = VISION_RELAY_MODEL;
        relayEngaged = true;
      }

      const attemptRound = async (modelId: string): Promise<CompletionRound> => {
        const controller = new AbortController();
        cancelState.controller = controller;
        try {
          return await completionDriver({
            apiKey: input.apiKey,
            modelId,
            messages,
            tools: openRouterTools,
            signal: controller.signal,
            onText: async (delta) => {
              visibleContent += delta;
              await flushContent();
            },
            onReasoning: async (delta) => {
              visibleReasoning += delta;
              await flushContent();
            },
          });
        } finally {
          cancelState.controller = null;
        }
      };

      // Retry a transient provider failure ONCE with the same messages. Any
      // partial stream from the failed attempt is rolled back first so the
      // retry can't double-append what already flushed.
      const contentMark = visibleContent.length;
      const reasoningMark = visibleReasoning.length;
      let round: CompletionRound;
      try {
        round = await attemptRound(roundModelId);
      } catch (error) {
        let retryable =
          error instanceof ProviderError &&
          error.retryable &&
          !cancelState.canceled;
        if (
          error instanceof ProviderError &&
          error.imageInputRejected &&
          roundHasImages &&
          !cancelState.canceled
        ) {
          if (provider === "openrouter" && !relayEngaged) {
            // The catalog believed this model takes images; the endpoint
            // disagreed. Rerun the round on the relay instead of replaying a
            // deterministic 404.
            roundModelId = VISION_RELAY_MODEL;
            relayEngaged = true;
          } else {
            // Even the relay refused the images (or the provider has no relay
            // at all). Swap them for text traces and give the round back to
            // the primary: the turn survives without vision.
            stripImageMessages(messages, IMAGE_UNDELIVERABLE_NOTE);
            roundModelId = input.modelId;
            relayEngaged = false;
          }
          retryable = true;
        }
        if (!retryable) throw error;
        visibleContent = visibleContent.slice(0, contentMark);
        visibleReasoning = visibleReasoning.slice(0, reasoningMark);
        await new Promise((resolve) => setTimeout(resolve, ROUND_RETRY_DELAY_MS));
        if (cancelState.canceled) throw new TurnCanceledError();
        round = await attemptRound(roundModelId);
      }
      if (round.model) providerModel = round.model;
      mergeUsage(providerUsage, round.usage);
      if (relayEngaged) {
        // The relay saw the renders; swap them for text traces so the next
        // round returns to the user's model and stops paying image tokens.
        stripImageMessages(messages, IMAGE_CONSUMED_NOTE);
      }

      if (round.toolCalls.length === 0) {
        if (!visibleContent.trim()) {
          // A reasoning model can put its entire answer in the reasoning
          // stream and emit no content. That used to throw "returned no
          // response" after minutes of billed work — surface the thinking
          // text as the reply instead.
          const salvage = round.reasoning.trim() || visibleReasoning.trim();
          if (!salvage) {
            throw new ProviderError("The model returned no response.");
          }
          visibleContent = salvage;
          // The reply now IS the thinking text. Persist reasoning byte-identical
          // to the content so the panel's `reasoning !== content` guard hides
          // the Thinking block — otherwise settleComplete stores the untrimmed /
          // multi-round visibleReasoning, which differs by whitespace and makes
          // the salvaged reply render twice.
          visibleReasoning = visibleContent;
        }
        return await settleComplete(false);
      }

      messages.push({
        role: "assistant",
        content: round.content || null,
        tool_calls: round.toolCalls,
      });

      // Execute the round's tool calls: concurrently when every call is a
      // pure read (the common read_slide + read_theme pair), serially
      // otherwise — writes may depend on a previous call's outcome. Results
      // are appended in call order either way, as the protocol requires.
      const results: Array<{ call: ToolCall; text: string; images: ImagePart[] }> = [];
      const allParallelSafe =
        round.toolCalls.length > 1 &&
        round.toolCalls.every((call) =>
          PARALLEL_SAFE_CHAT_TOOLS.has(call.function.name),
        );
      const toolCtx: AuthContext = {
        user_id: input.userId,
        workspace_id: input.workspaceId,
        assistant_message_id: input.assistantMessageId,
      };
      if (allParallelSafe) {
        const settled = await Promise.all(
          round.toolCalls.map((call) => executeToolCall(call, toolCtx)),
        );
        settled.forEach((result, i) =>
          results.push({ call: round.toolCalls[i], ...result }),
        );
      } else {
        for (const call of round.toolCalls) {
          if (cancelState.canceled) throw new TurnCanceledError();
          const result = await executeToolCall(call, toolCtx);
          results.push({ call, ...result });
        }
      }

      // Push every tool message FIRST, buffering the image user-messages, then
      // append the buffered ones after the last tool message. With
      // parallel_tool_calls a round can return several tool calls; interleaving
      // a user message between two tool messages (an image-returning call that
      // isn't last) makes strict OpenAI-compatible providers 400 the next
      // completion — and a 400 isn't retryable. Buffering keeps the images in
      // call order while satisfying the "all tool messages, then user" ordering.
      const imageFollowups: OpenRouterMessage[] = [];
      for (const { call, text, images } of results) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: text,
        });
        if (images.length > 0) {
          imageFollowups.push({
            role: "user",
            content: [
              {
                type: "text",
                text: `Rendered output from ${call.function.name}. Inspect the image${images.length === 1 ? "" : "s"} before deciding the next action.`,
              },
              ...images,
            ],
          });
        }
      }
      for (const followup of imageFollowups) messages.push(followup);
    }

    // Out of rounds: persist the partial progress as a completed reply with a
    // continue affordance instead of discarding minutes of work as an error.
    visibleContent = `${visibleContent.trimEnd()}${ROUND_LIMIT_NOTE}`;
    return await settleComplete(true);
  } catch (error) {
    if (
      cancelState.canceled ||
      error instanceof TurnCanceledError ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      await settleCanceled(input);
      return { status: "canceled" };
    }
    const safeMessage =
      error instanceof ProviderError
        ? error.userMessage
        : "Canvas could not complete the assistant turn. Try again.";
    if (!(error instanceof ProviderError)) {
      console.error("[openrouter:turn]", error);
    }
    const settledByUs = await settleError(input, safeMessage);
    if (!settledByUs) {
      // Stop settled the rows `canceled` in the instant before this write
      // (the watcher polls every ~900ms, so the flag can lag the DB). Mirror
      // the DB rather than reporting an error the user never saw.
      return { status: "canceled" };
    }
    return {
      status: "error",
      error: safeMessage,
      providerStatus: error instanceof ProviderError ? error.status : null,
      round: roundNumber,
      modelId: primaryModel,
    };
  } finally {
    clearInterval(cancelTimer);
    cancelState.controller?.abort();
  }
}
