import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runOpenRouterTurn,
  parseModelList,
} from "../src/lib/canvas/assistant/openrouter-runner";
import { resetOpenRouterCatalogForTests } from "../src/lib/canvas/assistant/openrouter-catalog";

// Two tools get controlled stand-ins so a round can drive an image-returning
// call next to a text one without a real Chromium render: render_slide hands
// back the tagged __mcpContent image shape (see mcp/tools' McpContentResult),
// read_theme a plain object. Everything else stays the real module — the
// descriptor list the request advertises is untouched.
vi.mock("@/lib/canvas/mcp/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/canvas/mcp/tools")>();
  return {
    ...actual,
    tools: {
      ...actual.tools,
      render_slide: async () => ({
        __mcpContent: [
          { type: "text", text: "Rendered slide at position 0." },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" },
        ],
      }),
      read_theme: async () => ({ theme_css: "body{color:#000}" }),
    },
  };
});

type Row = Record<string, unknown>;

class QueryBuilder {
  private filters: Array<{ column: string; value: unknown }> = [];
  private operation: "select" | "update" = "select";
  private patch: Row = {};
  private limitCount: number | null = null;

  constructor(
    private table: string,
    private db: Record<string, Row[]>,
  ) {}

  select() {
    return this;
  }
  update(patch: Row) {
    this.operation = "update";
    this.patch = patch;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }
  order() {
    return this;
  }
  limit(count: number) {
    this.limitCount = count;
    return this;
  }
  maybeSingle() {
    return this.execute().then(({ data, error }) => ({
      data: data[0] ?? null,
      error,
    }));
  }
  then<T>(onFulfilled?: (value: { data: Row[]; error: null }) => T) {
    return this.execute().then(
      onFulfilled as (value: { data: Row[]; error: null }) => T,
    );
  }
  private execute(): Promise<{ data: Row[]; error: null }> {
    const table = (this.db[this.table] = this.db[this.table] ?? []);
    let rows = table.filter((row) =>
      this.filters.every((filter) => row[filter.column] === filter.value),
    );
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    if (this.operation === "update") {
      for (const row of rows) Object.assign(row, this.patch);
    }
    return Promise.resolve({ data: rows, error: null });
  }
}

function makeDb() {
  const db: Record<string, Row[]> = {
    canvas_assistant_message: [
      {
        id: "user-message",
        thread_id: "thread-1",
        user_id: "user-1",
        role: "user",
        content: "Tighten the headline",
        status: "running",
        created_at: "2026-01-01T00:00:00.000Z",
        cancel_requested_at: null,
      },
      {
        id: "assistant-message",
        thread_id: "thread-1",
        user_id: "user-1",
        role: "assistant",
        content: "",
        status: "streaming",
        created_at: "2026-01-01T00:00:01.000Z",
      },
    ],
  };
  return {
    db,
    admin: {
      from: (table: string) => new QueryBuilder(table, db),
    },
  };
}

function sse(events: unknown[]): Response {
  const body = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function turnInput(admin: ReturnType<typeof makeDb>["admin"]) {
  return {
    admin: admin as never,
    userMessageId: "user-message",
    assistantMessageId: "assistant-message",
    userId: "user-1",
    workspaceId: "workspace-1",
    deckId: "deck-1",
    threadId: "thread-1",
    apiKey: "sk-or-v1-test",
    modelId: "openrouter/auto",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetOpenRouterCatalogForTests();
});

describe("OpenRouter agent runner", () => {
  it("streams text into the assistant row and settles both sides complete", async () => {
    const { db, admin } = makeDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          {
            model: "anthropic/claude-sonnet-4",
            choices: [{ delta: { content: "Proposed " } }],
          },
          {
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
            choices: [{ delta: { content: "the tighter headline." } }],
          },
        ]),
      ),
    );

    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result).toEqual({
      status: "complete",
      model: "anthropic/claude-sonnet-4",
    });
    const user = db.canvas_assistant_message[0];
    const assistant = db.canvas_assistant_message[1];
    expect(user.status).toBe("complete");
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("Proposed the tighter headline.");
    expect(assistant.provider_model).toBe("anthropic/claude-sonnet-4");
    expect(assistant.provider_usage).toMatchObject({ total_tokens: 24 });
  });

  it("feeds normalized tool results back into the next completion round", async () => {
    const { db, admin } = makeDb();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sse([
          {
            model: "google/gemini-test",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "unknown_canvas_tool", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          },
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          {
            model: "google/gemini-test",
            choices: [{ delta: { content: "I could not use that tool." } }],
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    await runOpenRouterTurn(turnInput(admin));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    ) as { messages: Array<{ role: string; content: string }> };
    expect(secondBody.messages.some((message) => message.role === "tool")).toBe(true);
    expect(
      secondBody.messages.find((message) => message.role === "tool")?.content,
    ).toContain("Unknown Canvas tool");
    expect(db.canvas_assistant_message[1].status).toBe("complete");
  });

  it("streams delta.reasoning into the row and keeps the panel alive", async () => {
    const { db, admin } = makeDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          { model: "z-ai/glm-5.2", choices: [{ delta: { reasoning: "Let me think… " } }] },
          { choices: [{ delta: { reasoning: "the headline is long." } }] },
          {
            usage: { total_tokens: 40 },
            choices: [{ delta: { content: "Tightened it." } }],
          },
        ]),
      ),
    );
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result.status).toBe("complete");
    const assistant = db.canvas_assistant_message[1];
    expect(assistant.content).toBe("Tightened it.");
    expect(assistant.reasoning).toBe("Let me think… the headline is long.");
  });

  it("salvages a reasoning-only round instead of erroring 'returned no response'", async () => {
    const { db, admin } = makeDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          {
            model: "z-ai/glm-5.2",
            choices: [{ delta: { reasoning: "The answer is 42." } }],
          },
        ]),
      ),
    );
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result.status).toBe("complete");
    const assistant = db.canvas_assistant_message[1];
    // The reasoning became the reply rather than a dead "no response" error.
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toBe("The answer is 42.");
  });

  it("salvages reasoning with trailing whitespace and stores reasoning byte-identical to content", async () => {
    const { db, admin } = makeDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          {
            model: "z-ai/glm-5.2",
            // Trailing newline: the raw reasoning stream differs from its
            // trimmed reply by whitespace.
            choices: [{ delta: { reasoning: "The answer is 42.\n" } }],
          },
        ]),
      ),
    );
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result.status).toBe("complete");
    const assistant = db.canvas_assistant_message[1];
    // The reply is the TRIMMED thinking text…
    expect(assistant.content).toBe("The answer is 42.");
    // …and reasoning is persisted equal to it (not the untrimmed stream), so
    // the panel's `reasoning !== content` guard hides the duplicate Thinking
    // block instead of rendering the salvaged reply twice.
    expect(assistant.reasoning).toBe("The answer is 42.");
    expect(assistant.reasoning).toBe(assistant.content);
  });

  it("salvages only the LAST round's reasoning, not the accumulated stream", async () => {
    const { db, admin } = makeDb();
    const fetchMock = vi
      .fn()
      // Round 1: reasoning + a tool call, so the turn advances to a 2nd round
      // (visibleReasoning accumulates across rounds).
      .mockResolvedValueOnce(
        sse([
          {
            model: "z-ai/glm-5.2",
            choices: [{ delta: { reasoning: "First round thinking. " } }],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "unknown_canvas_tool", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          },
        ]),
      )
      // Round 2: reasoning-only (no content, no tool calls) → salvage path.
      .mockResolvedValueOnce(
        sse([
          {
            model: "z-ai/glm-5.2",
            choices: [{ delta: { reasoning: "The final answer is 42.\n" } }],
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result.status).toBe("complete");
    const assistant = db.canvas_assistant_message[1];
    // Only round 2's reasoning is the reply; "First round thinking. " must not
    // leak into either field, and reasoning stays equal to content.
    expect(assistant.content).toBe("The final answer is 42.");
    expect(assistant.reasoning).toBe("The final answer is 42.");
    expect(assistant.reasoning).toBe(assistant.content);
  });

  it("retries a 404 round once and completes on the retry", async () => {
    const { db, admin } = makeDb();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("gone", { status: 404 }))
      .mockResolvedValueOnce(
        sse([
          { model: "z-ai/glm-5.2", choices: [{ delta: { content: "Recovered." } }] },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("complete");
    expect(db.canvas_assistant_message[1].content).toBe("Recovered.");
  });

  it("reports diagnostics (status, round, model) when a turn errors after the retry", async () => {
    const { admin } = makeDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const result = await runOpenRouterTurn({
      ...turnInput(admin),
      modelId: "z-ai/glm-5.2-dated",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.providerStatus).toBe(404);
    expect(result.round).toBe(1);
    expect(result.modelId).toBe("z-ai/glm-5.2-dated");
  });

  it("sends a models fallback array for a comma-separated model spec", async () => {
    const { admin } = makeDb();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async () =>
      sse([{ model: "z-ai/glm-5.2", choices: [{ delta: { content: "hi" } }] }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runOpenRouterTurn({
      ...turnInput(admin),
      modelId: "z-ai/glm-5.2-20260616, z-ai/glm-5.2",
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { model: string; models?: string[] };
    expect(body.model).toBe("z-ai/glm-5.2-20260616");
    expect(body.models).toEqual(["z-ai/glm-5.2-20260616", "z-ai/glm-5.2"]);
  });

  it("reports canceled — not complete — when Stop settled the rows mid-stream", async () => {
    const { db, admin } = makeDb();
    // Stop landed while the final round streamed: cancelAssistantTurn flips
    // both rows to `canceled` synchronously, but the in-process watcher polls
    // every ~900ms so the runner's flag can lag the DB. The guarded settle
    // must detect the 0-row write and mirror the DB truth.
    db.canvas_assistant_message[0].status = "canceled";
    db.canvas_assistant_message[1].status = "canceled";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([{ model: "m", choices: [{ delta: { content: "Late words." } }] }]),
      ),
    );
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result).toEqual({ status: "canceled" });
    // The settle neither resurrected nor clobbered the canceled rows.
    expect(db.canvas_assistant_message[0].status).toBe("canceled");
    expect(db.canvas_assistant_message[1].status).toBe("canceled");
    expect(db.canvas_assistant_message[1].content).toBe("");
  });

  it("reports canceled — not error — when Stop settled the rows before a failed turn's settle", async () => {
    const { db, admin } = makeDb();
    db.canvas_assistant_message[0].status = "canceled";
    db.canvas_assistant_message[1].status = "canceled";
    // The provider fails, the catch goes to settle `error` — but the guarded
    // write matches nothing because the rows are already `canceled`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );
    const result = await runOpenRouterTurn(turnInput(admin));
    expect(result).toEqual({ status: "canceled" });
    expect(db.canvas_assistant_message[1].status).toBe("canceled");
    expect(db.canvas_assistant_message[1].error ?? null).toBeNull();
  });

  it("executes read-only tool calls in parallel (parallel_tool_calls stays on)", async () => {
    const { admin } = makeDb();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async () =>
      sse([{ model: "m", choices: [{ delta: { content: "done" } }] }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runOpenRouterTurn(turnInput(admin));
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { parallel_tool_calls: boolean };
    expect(body.parallel_tool_calls).toBe(true);
  });

  it("appends buffered image user-messages AFTER every tool message of a round", async () => {
    const { admin } = makeDb();
    const chatQueue = [
      // One round, two parallel tool calls: the FIRST returns an image
      // (render_slide), the SECOND returns text (read_theme).
      sse([
        {
          model: "z-ai/glm-5.2",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "render_slide", arguments: "{}" },
                  },
                  {
                    index: 1,
                    id: "call_2",
                    function: { name: "read_theme", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      ]),
      // Second round wraps up so the turn settles.
      sse([{ model: "z-ai/glm-5.2", choices: [{ delta: { content: "done" } }] }]),
    ];
    // Once images enter the turn, the runner consults the model catalog (the
    // vision-relay gate), so the fetch mock must branch on URL instead of
    // relying on call order. openrouter/auto really is image-capable, so the
    // gate stays out of the way here.
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "openrouter/auto",
                architecture: { input_modalities: ["text", "image"] },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return chatQueue.shift() ?? sse([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await runOpenRouterTurn(turnInput(admin));

    const chatCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/chat/completions"),
    ) as unknown as Array<[string, RequestInit]>;
    const secondBody = JSON.parse(chatCalls[1][1].body as string) as {
      messages: Array<{
        role: string;
        content: unknown;
        tool_calls?: Array<{ id: string }>;
        tool_call_id?: string;
      }>;
    };
    const msgs = secondBody.messages;
    const roles = msgs.map((m) => m.role);

    // The assistant turn advertised BOTH tool_call ids.
    const assistantIdx = msgs.findIndex(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(msgs[assistantIdx].tool_calls?.map((c) => c.id)).toEqual([
      "call_1",
      "call_2",
    ]);

    // Both tool results are present, in call order, and CONTIGUOUS — no user
    // message wedged between them (which strict OpenAI-compatible providers 400,
    // and a 400 isn't retryable).
    const firstTool = roles.indexOf("tool");
    const lastTool = roles.lastIndexOf("tool");
    expect(
      msgs.slice(firstTool, lastTool + 1).map((m) => m.tool_call_id),
    ).toEqual(["call_1", "call_2"]);

    // The buffered image user-message lands AFTER the last tool message (every
    // tool_call_id precedes any user role that follows the assistant turn).
    const imageUserIdx = msgs.findIndex(
      (m, i) => i > assistantIdx && m.role === "user" && Array.isArray(m.content),
    );
    expect(imageUserIdx).toBeGreaterThan(lastTool);
    const imageParts = msgs[imageUserIdx].content as Array<{ type: string }>;
    expect(imageParts.some((p) => p.type === "image_url")).toBe(true);
  });
});

describe("parseModelList", () => {
  it("splits primary and fallbacks", () => {
    expect(parseModelList("a/b, c/d, e/f")).toEqual({
      primary: "a/b",
      models: ["a/b", "c/d", "e/f"],
    });
  });
  it("handles a single model", () => {
    expect(parseModelList("openrouter/auto")).toEqual({
      primary: "openrouter/auto",
      models: ["openrouter/auto"],
    });
  });
});
