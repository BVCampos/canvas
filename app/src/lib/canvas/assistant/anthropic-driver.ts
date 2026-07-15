import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type ChatToolDescriptor,
  type CompletionDriver,
  type CompletionRound,
  type ImagePart,
  type OpenRouterMessage,
  type TextPart,
  type ToolCall,
} from "@/lib/canvas/assistant/completion-types";
import { parseOpenRouterModels } from "@/lib/canvas/assistant/openrouter-client";

// Native Anthropic Messages API driver (ADR-0014). The turn loop stays in the
// runner's OpenAI-shaped message space; this module converts at the boundary
// in both directions. Deliberate request-shape constraints:
//   - no `temperature`/`top_p`/`top_k` — the current Claude generation
//     (claude-opus-4-8, claude-sonnet-5) 400s on them;
//   - no `thinking` param at all — claude-haiku-4-5 rejects adaptive, and
//     claude-sonnet-5 runs adaptive by default when the field is omitted;
//   - cache_control on the system block — tools render before system, so the
//     one breakpoint caches the big Canvas tool schemas + system prefix that
//     re-runs every round.
const ANTHROPIC_MAX_TOKENS = 16000;

type AnthropicContentBlockParam = Record<string, unknown>;
type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlockParam[];
};

// [\s\S] instead of the dotAll flag: base64 payloads never contain newlines,
// but the tsconfig target predates /s.
const DATA_URI_RE = /^data:([^;,]+);base64,([\s\S]*)$/;

// image_url parts are either the runner's own base64 data URIs (render
// attachments) or plain http(s) URLs; the Messages API takes each as a
// different image source shape.
export function toAnthropicImageBlock(part: ImagePart): AnthropicContentBlockParam {
  const url = part.image_url.url;
  const dataMatch = DATA_URI_RE.exec(url);
  if (dataMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataMatch[1],
        data: dataMatch[2],
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function toUserContent(
  content: string | Array<TextPart | ImagePart>,
): string | AnthropicContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? ({ type: "text", text: part.text } satisfies AnthropicContentBlockParam)
      : toAnthropicImageBlock(part),
  );
}

function toAssistantContent(message: {
  content: string | null;
  tool_calls?: ToolCall[];
}): AnthropicContentBlockParam[] {
  const blocks: AnthropicContentBlockParam[] = [];
  if (message.content) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = call.function.arguments.trim()
        ? JSON.parse(call.function.arguments)
        : {};
    } catch {
      // The model produced unparseable arguments; preserve the raw string so
      // the round-trip stays lossless instead of dropping the call.
      input = { __raw_arguments: call.function.arguments };
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    });
  }
  return blocks;
}

/**
 * Convert the runner's OpenAI-shaped transcript into Messages API params.
 * System messages are hoisted out (returned separately); CONSECUTIVE tool
 * messages merge into ONE user message of tool_result blocks — the Messages
 * API requires all parallel tool results to share a single user message.
 */
export function toAnthropicMessages(messages: OpenRouterMessage[]): {
  system: string;
  messages: AnthropicMessageParam[];
} {
  const systemTexts: string[] = [];
  const converted: AnthropicMessageParam[] = [];
  let pendingToolResults: AnthropicContentBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    converted.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      systemTexts.push(
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (typeof part.text === "string" ? part.text : ""))
              .join("\n"),
      );
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      });
      continue;
    }
    flushToolResults();
    if (message.role === "user") {
      converted.push({ role: "user", content: toUserContent(message.content) });
    } else {
      converted.push({ role: "assistant", content: toAssistantContent(message) });
    }
  }
  flushToolResults();

  // The Messages API requires messages[0] to be a user turn; the runner's
  // history window can open on an assistant reply after truncation.
  if (converted[0]?.role === "assistant") {
    converted.unshift({
      role: "user",
      content: "(Earlier conversation context was truncated.)",
    });
  }

  return { system: systemTexts.join("\n"), messages: converted };
}

export function toAnthropicTools(
  tools: ChatToolDescriptor[],
): Array<{ name: string; description: string; input_schema: unknown }> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

/**
 * Full request shape (minus streaming plumbing) — pure so tests can pin the
 * boundary contract: sampling params and `thinking` absent, cache_control on
 * the system block, tool_result merging, image conversion.
 */
export function toAnthropicRequest(input: {
  modelId: string;
  messages: OpenRouterMessage[];
  tools: ChatToolDescriptor[];
}): Record<string, unknown> {
  // A comma list is rejected at save time for Anthropic; parse defensively so
  // a legacy row can't send a comma-joined string as the model id.
  const { primary } = parseOpenRouterModels(input.modelId);
  const { system, messages } = toAnthropicMessages(input.messages);
  return {
    model: primary,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    // One breakpoint on the system block caches the tools+system prefix
    // (tools render first) across the turn's rounds.
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ],
    tools: toAnthropicTools(input.tools),
    messages,
  };
}

/** Response content blocks → the runner's CompletionRound halves. */
export function fromAnthropicContent(content: Array<Record<string, unknown>>): {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoning += block.thinking;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `canvas_tool_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return {
    content: text,
    reasoning,
    toolCalls: toolCalls.filter((call) => call.function.name),
  };
}

function anthropicErrorForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Anthropic rejected the saved API key. Reconnect it in Connections.";
  }
  if (status === 404) {
    return "The selected Anthropic model is not available on this key. Choose another in Connections.";
  }
  if (status === 429) {
    return "Anthropic is rate-limiting this key. Wait a moment and retry.";
  }
  if (status >= 500) {
    return "Anthropic is temporarily overloaded. Try again shortly.";
  }
  return "The selected Anthropic model could not run this request. Check the model in Connections.";
}

function mapAnthropicError(error: unknown, signal: AbortSignal): never {
  // Cancellation must keep flowing as a cancel, not become a retryable flap.
  if (
    error instanceof Anthropic.APIUserAbortError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    signal.aborted
  ) {
    throw error;
  }
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    const status = error.status;
    // 400 mentioning image input = the model can't take the render images;
    // the runner's strip-images fallback is the recovery, not a retry.
    if (status === 400 && /image/i.test(error.message ?? "")) {
      throw new ProviderError(anthropicErrorForStatus(status), status, false, true);
    }
    throw new ProviderError(
      anthropicErrorForStatus(status),
      status,
      status === 408 || status === 429 || status >= 500,
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    throw new ProviderError(
      "Anthropic could not be reached. Check connectivity and retry.",
      null,
      true,
    );
  }
  throw error;
}

export const anthropicCompletionDriver: CompletionDriver = async (
  input,
): Promise<CompletionRound> => {
  // The runner owns retries (one per round) — SDK retries on top of that
  // would triple the wait on a rate-limited key.
  const client = new Anthropic({ apiKey: input.apiKey, maxRetries: 0 });
  const request = toAnthropicRequest(input);

  try {
    const stream = client.messages.stream(
      request as Parameters<typeof client.messages.stream>[0],
      { signal: input.signal },
    );

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        await input.onText(event.delta.text);
      } else if (event.delta.type === "thinking_delta") {
        // Adaptive thinking summaries ride the existing reasoning channel.
        await input.onReasoning(event.delta.thinking);
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new ProviderError("The model declined this request.", null, false);
    }
    // stop_reason === "max_tokens" intentionally falls through: like the
    // OpenRouter length case, the truncated round is returned as-is and the
    // runner settles whatever content/tool calls arrived.
    const round = fromAnthropicContent(
      final.content as unknown as Array<Record<string, unknown>>,
    );
    return {
      ...round,
      model: final.model,
      usage: final.usage as unknown as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    mapAnthropicError(error, input.signal);
  }
};
