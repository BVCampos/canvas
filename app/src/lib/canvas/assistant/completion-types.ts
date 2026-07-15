// The OpenAI-shaped message space the assistant turn loop runs in, extracted
// so the per-provider completion drivers (openai-compat-driver.ts,
// anthropic-driver.ts) and the runner share one vocabulary. The runner owns
// rounds, tool execution, persistence, and cancellation; a driver owns exactly
// one completion call: messages in → streamed deltas out → CompletionRound.

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenRouterMessage =
  | { role: "system"; content: string | Array<Record<string, unknown>> }
  | { role: "user"; content: string | Array<TextPart | ImagePart> }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type ChatToolDescriptor = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

export type CompletionRound = {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  model: string | null;
  usage: Record<string, unknown> | null;
};

export type CompletionInput = {
  apiKey: string;
  modelId: string;
  messages: OpenRouterMessage[];
  tools: ChatToolDescriptor[];
  signal: AbortSignal;
  onText: (delta: string) => Promise<void>;
  onReasoning: (delta: string) => Promise<void>;
};

export type CompletionDriver = (input: CompletionInput) => Promise<CompletionRound>;

export class ProviderError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly status: number | null = null,
    public readonly retryable: boolean = false,
    // The provider refused image_url parts ("no endpoints support image
    // input"). Deterministic — a same-model retry can never fix it; the round
    // loop reroutes to the vision relay (OpenRouter) or strips the images.
    public readonly imageInputRejected: boolean = false,
  ) {
    super(userMessage);
  }
}
