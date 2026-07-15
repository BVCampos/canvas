import "server-only";

import {
  ProviderError,
  type CompletionDriver,
  type CompletionInput,
  type CompletionRound,
  type ToolCall,
} from "@/lib/canvas/assistant/completion-types";
import { parseOpenRouterModels } from "@/lib/canvas/assistant/openrouter-client";

// One streaming implementation serves every /chat/completions-shaped endpoint;
// the profile carries what actually differs between vendors: URL, auth header,
// sampling/token body fields, and user-facing error copy. OpenRouter's profile
// reproduces the pre-extraction behavior exactly (models fallback array,
// image-input 404 detection, its error copy); OpenAI's differs where its API
// does (max_completion_tokens, no temperature on the gpt-5 family, usage only
// via stream_options).
type OpenAiCompatProfile = {
  logTag: string;
  chatUrl: string;
  headers: (apiKey: string) => Record<string, string>;
  // Sampling/token/model fields merged into the request body. `models` is the
  // parsed comma-list; only OpenRouter forwards fallbacks server-side.
  body: (primary: string, models: string[]) => Record<string, unknown>;
  errorForStatus: (status: number) => string;
  unreachableMessage: string;
  emptyStreamMessage: string;
  streamStoppedMessage: string;
  // OpenRouter 404s a whole round when image_url parts hit a text-only model;
  // flagging it lets the runner reroute to the vision relay instead of
  // replaying a deterministic failure.
  imageInputRejectedMessage: string | null;
};

// Transient provider failures worth one fresh attempt: routing flaps (404 on
// an alias that just served a turn), rate-limit blips, provider 5xx, and
// network-level failures. Auth/credit problems are stable — retrying only
// doubles the pain.
function retryableStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function appendToolCallDelta(
  calls: Map<number, ToolCall>,
  raw: unknown,
): void {
  if (!raw || typeof raw !== "object") return;
  const delta = raw as {
    index?: unknown;
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const index = typeof delta.index === "number" ? delta.index : calls.size;
  const existing = calls.get(index) ?? {
    id: "",
    type: "function" as const,
    function: { name: "", arguments: "" },
  };
  if (typeof delta.id === "string") existing.id += delta.id;
  if (typeof delta.function?.name === "string") {
    existing.function.name += delta.function.name;
  }
  if (typeof delta.function?.arguments === "string") {
    existing.function.arguments += delta.function.arguments;
  }
  calls.set(index, existing);
}

async function streamCompletion(
  profile: OpenAiCompatProfile,
  input: CompletionInput,
): Promise<CompletionRound> {
  const { primary, models } = parseOpenRouterModels(input.modelId);
  let response: Response;
  try {
    response = await fetch(profile.chatUrl, {
      method: "POST",
      signal: input.signal,
      headers: {
        ...profile.headers(input.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...profile.body(primary, models),
        messages: input.messages,
        tools: input.tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        stream: true,
      }),
    });
  } catch (error) {
    // AbortError must keep flowing as a cancel, not be retried as a flap.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ProviderError(profile.unreachableMessage, null, true);
  }

  if (!response.ok) {
    // Read the body for the server logs — prod image-input 404s were
    // undiagnosable with it discarded — but never surface raw provider
    // details to the user (they may contain request fragments or account
    // metadata).
    const rawBody = await response.text().catch(() => "");
    console.error(
      `[${profile.logTag}:completion]`,
      primary,
      response.status,
      rawBody.slice(0, 500),
    );
    if (
      profile.imageInputRejectedMessage &&
      response.status === 404 &&
      /image input/i.test(rawBody)
    ) {
      throw new ProviderError(
        profile.imageInputRejectedMessage,
        response.status,
        false,
        true,
      );
    }
    throw new ProviderError(
      profile.errorForStatus(response.status),
      response.status,
      retryableStatus(response.status),
    );
  }
  if (!response.body) {
    throw new ProviderError(profile.emptyStreamMessage, null, true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCall>();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let model: string | null = null;
  let usage: Record<string, unknown> | null = null;

  const consumeLine = async (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event: {
      error?: unknown;
      model?: unknown;
      usage?: unknown;
      choices?: Array<{
        delta?: {
          content?: unknown;
          reasoning?: unknown;
          reasoning_content?: unknown;
          tool_calls?: unknown;
        };
      }>;
    };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      return;
    }
    if (event.error) {
      console.error(
        `[${profile.logTag}:completion]`,
        primary,
        "stream-error",
        JSON.stringify(event.error).slice(0, 500),
      );
      throw new ProviderError(profile.streamStoppedMessage, null, true);
    }
    if (typeof event.model === "string") model = event.model;
    if (event.usage && typeof event.usage === "object") {
      usage = event.usage as Record<string, unknown>;
    }
    const delta = event.choices?.[0]?.delta;
    // Reasoning models stream their thinking as delta.reasoning (OpenRouter's
    // normalized field; reasoning_content is the DeepSeek-style spelling some
    // providers pass through). Dropping it left the panel dead for the whole
    // reasoning phase — minutes on glm-5.2.
    const reasoningDelta =
      typeof delta?.reasoning === "string"
        ? delta.reasoning
        : typeof delta?.reasoning_content === "string"
          ? delta.reasoning_content
          : null;
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      await input.onReasoning(reasoningDelta);
    }
    if (typeof delta?.content === "string") {
      content += delta.content;
      await input.onText(delta.content);
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const call of delta.tool_calls) appendToolCallDelta(toolCalls, call);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) await consumeLine(line);
    if (done) break;
  }
  if (buffer.trim()) await consumeLine(buffer.trim());

  const completedCalls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call], index) => ({
      ...call,
      id: call.id || `canvas_tool_${index}`,
    }))
    .filter((call) => call.function.name);

  return { content, reasoning, toolCalls: completedCalls, model, usage };
}

function openRouterErrorForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "OpenRouter rejected the saved API key. Reconnect it in Connections.";
  }
  if (status === 402) {
    return "This OpenRouter account does not have enough credits for the request.";
  }
  if (status === 404) {
    return "The selected OpenRouter model is no longer available. Choose another in Connections.";
  }
  if (status === 429) {
    return "OpenRouter is rate-limiting this key. Wait a moment and retry.";
  }
  if (status >= 500) {
    return "OpenRouter or its model provider is temporarily unavailable. Try again shortly.";
  }
  return "The selected OpenRouter model could not run this request. Check the model in Connections.";
}

const OPENROUTER_PROFILE: OpenAiCompatProfile = {
  logTag: "openrouter",
  chatUrl: "https://openrouter.ai/api/v1/chat/completions",
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer":
      process.env.NEXT_PUBLIC_APP_URL ?? "https://canvas.21xventures.com",
    "X-OpenRouter-Title": "21x Canvas",
  }),
  // The stored model id may be a comma-separated preference list: the first
  // entry is the primary and the rest ride OpenRouter's `models` fallback
  // array, so a routing flap on one id fails over server-side.
  body: (primary, models) => ({
    model: primary,
    ...(models.length > 1 ? { models } : {}),
    temperature: 0.2,
    max_tokens: 8192,
  }),
  errorForStatus: openRouterErrorForStatus,
  unreachableMessage: "OpenRouter could not be reached. Check connectivity and retry.",
  emptyStreamMessage: "OpenRouter returned an empty response stream.",
  streamStoppedMessage:
    "The OpenRouter model provider stopped the response. Try again or choose another model.",
  imageInputRejectedMessage:
    "The selected OpenRouter model cannot view rendered images. Choose a vision-capable model in Connections.",
};

function openAiErrorForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "OpenAI rejected the saved API key. Reconnect it in Connections.";
  }
  if (status === 402) {
    return "This OpenAI account does not have enough credit for the request.";
  }
  if (status === 404) {
    return "The selected OpenAI model is not available on this key. Choose another in Connections.";
  }
  if (status === 429) {
    return "OpenAI is rate-limiting this key (or it is out of quota). Wait a moment and retry.";
  }
  if (status >= 500) {
    return "OpenAI is temporarily unavailable. Try again shortly.";
  }
  return "The selected OpenAI model could not run this request. Check the model in Connections.";
}

const OPENAI_PROFILE: OpenAiCompatProfile = {
  logTag: "openai",
  chatUrl: "https://api.openai.com/v1/chat/completions",
  headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  // Single model only — fallback lists are an OpenRouter concept. The gpt-5
  // family rejects `temperature` and `max_tokens` (reasoning models take
  // max_completion_tokens), and streamed usage needs an explicit opt-in.
  body: (primary) => ({
    model: primary,
    max_completion_tokens: 8192,
    stream_options: { include_usage: true },
  }),
  errorForStatus: openAiErrorForStatus,
  unreachableMessage: "OpenAI could not be reached. Check connectivity and retry.",
  emptyStreamMessage: "OpenAI returned an empty response stream.",
  streamStoppedMessage: "OpenAI stopped the response. Try again shortly.",
  imageInputRejectedMessage: null,
};

export const openRouterCompletionDriver: CompletionDriver = (input) =>
  streamCompletion(OPENROUTER_PROFILE, input);

export const openAiCompletionDriver: CompletionDriver = (input) =>
  streamCompletion(OPENAI_PROFILE, input);
