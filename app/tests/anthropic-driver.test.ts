import { describe, expect, it } from "vitest";
import {
  fromAnthropicContent,
  toAnthropicImageBlock,
  toAnthropicMessages,
  toAnthropicRequest,
  toAnthropicTools,
} from "../src/lib/canvas/assistant/anthropic-driver";

// Boundary-conversion contract for the native Anthropic driver (ADR-0014).
// The runner keeps its OpenAI-shaped message space; these pure functions are
// the entire translation layer, so every rule the Messages API enforces is
// pinned here: tool_calls↔tool_use in both directions, parallel tool results
// merged into ONE user message, data-URI images to base64 sources,
// cache_control on system, and sampling/thinking params absent.

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_slide",
      description: "Read one slide.",
      parameters: { type: "object", properties: { slide_id: { type: "string" } } },
    },
  },
];

describe("toAnthropicMessages", () => {
  it("converts assistant tool_calls into tool_use blocks with parsed input", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "Fix the title" },
      {
        role: "assistant",
        content: "Reading the slide first.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_slide", arguments: '{"slide_id":"s1"}' },
          },
        ],
      },
    ]);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Reading the slide first." },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_slide",
          input: { slide_id: "s1" },
        },
      ],
    });
  });

  it("omits the text block for a content-less tool-call turn", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_slide", arguments: "" },
          },
        ],
      },
    ]);
    expect(messages[1].content).toEqual([
      { type: "tool_use", id: "call_1", name: "read_slide", input: {} },
    ]);
  });

  it("merges CONSECUTIVE tool messages into ONE user message of tool_results", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_slide", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "read_theme", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "read_slide", content: "slide html" },
      { role: "tool", tool_call_id: "call_2", name: "read_theme", content: "theme css" },
      { role: "user", content: "now inspect the render" },
    ]);
    // Parallel tool results must share a single user message on the Messages
    // API — two consecutive tool-result user messages get rejected.
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "slide html" },
      { type: "tool_result", tool_use_id: "call_2", content: "theme css" },
    ]);
  });

  it("hoists system text out and guards a truncated history that opens on assistant", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "You are the Canvas agent." },
      { role: "assistant", content: "Earlier reply." },
      { role: "user", content: "Continue." },
    ]);
    expect(system).toBe("You are the Canvas agent.");
    expect(messages[0].role).toBe("user");
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Earlier reply." }],
    });
  });

  it("converts data-URI images to base64 sources and http URLs to url sources", () => {
    const { messages } = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Rendered output" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" },
          },
          {
            type: "image_url",
            image_url: { url: "https://example.com/img.png" },
          },
        ],
      },
    ]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "Rendered output" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "aW1hZ2U=" },
      },
      { type: "image", source: { type: "url", url: "https://example.com/img.png" } },
    ]);
  });
});

describe("toAnthropicImageBlock", () => {
  it("keeps the media type from the data URI", () => {
    expect(
      toAnthropicImageBlock({
        type: "image_url",
        image_url: { url: "data:image/png;base64,QUJD" },
      }),
    ).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });
});

describe("toAnthropicRequest", () => {
  const request = toAnthropicRequest({
    modelId: "claude-sonnet-5",
    messages: [
      { role: "system", content: "You are the Canvas agent." },
      { role: "user", content: "hi" },
    ],
    tools: TOOLS,
  });

  it("places cache_control on the system block (caches tools+system prefix)", () => {
    expect(request.system).toEqual([
      {
        type: "text",
        text: "You are the Canvas agent.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("maps runner tool descriptors to Anthropic input_schema tools", () => {
    expect(request.tools).toEqual(toAnthropicTools(TOOLS));
    expect(request.tools).toEqual([
      {
        name: "read_slide",
        description: "Read one slide.",
        input_schema: TOOLS[0].function.parameters,
      },
    ]);
  });

  it("sends NO sampling params and NO thinking param", () => {
    // claude-opus-4-8 / claude-sonnet-5 400 on temperature/top_p/top_k, and
    // claude-haiku-4-5 rejects an explicit thinking config — omission is the
    // only shape valid across all three presets.
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("top_k");
    expect(request).not.toHaveProperty("thinking");
    expect(request.max_tokens).toBe(16000);
    expect(request.model).toBe("claude-sonnet-5");
  });
});

describe("fromAnthropicContent", () => {
  it("converts tool_use blocks back into runner ToolCalls with stringified args", () => {
    const round = fromAnthropicContent([
      { type: "text", text: "Proposing a patch. " },
      { type: "thinking", thinking: "The headline is long." },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "propose_slide_patch",
        input: { deck_id: "d1", find: "a", replace: "b" },
      },
    ]);
    expect(round.content).toBe("Proposing a patch. ");
    expect(round.reasoning).toBe("The headline is long.");
    expect(round.toolCalls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: {
          name: "propose_slide_patch",
          arguments: JSON.stringify({ deck_id: "d1", find: "a", replace: "b" }),
        },
      },
    ]);
  });

  it("round-trips: a converted ToolCall re-converts to the same tool_use input", () => {
    const round = fromAnthropicContent([
      { type: "tool_use", id: "toolu_2", name: "read_slide", input: { slide_id: "s9" } },
    ]);
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: round.toolCalls },
    ]);
    expect(messages[1].content).toEqual([
      { type: "tool_use", id: "toolu_2", name: "read_slide", input: { slide_id: "s9" } },
    ]);
  });
});
