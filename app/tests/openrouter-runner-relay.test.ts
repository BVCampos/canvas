import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenRouterTurn } from "../src/lib/canvas/assistant/openrouter-runner";
import { resetOpenRouterCatalogForTests } from "../src/lib/canvas/assistant/openrouter-catalog";

// The registry's render_slide hits Supabase + Chromium; the relay tests only
// need "a tool call whose result carries an image", so it is stubbed here.
vi.mock("@/lib/canvas/mcp/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/canvas/mcp/tools")>();
  return {
    ...actual,
    tools: {
      ...actual.tools,
      render_slide: async () => ({
        __mcpContent: [
          { type: "text", text: "Rendered slide s1 at 1920x1080." },
          { type: "image", data: "aWJy", mimeType: "image/png" },
        ],
      }),
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
        content: "Fix the title slide and verify it",
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

function turnInput(admin: ReturnType<typeof makeDb>["admin"], modelId: string) {
  return {
    admin: admin as never,
    userMessageId: "user-message",
    assistantMessageId: "assistant-message",
    userId: "user-1",
    workspaceId: "workspace-1",
    deckId: "deck-1",
    threadId: "thread-1",
    apiKey: "sk-or-v1-test",
    modelId,
  };
}

function catalogResponse(
  models: Array<{ id: string; modalities: string[] }>,
): Response {
  return new Response(
    JSON.stringify({
      data: models.map((model) => ({
        id: model.id,
        architecture: { input_modalities: model.modalities },
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// A Response body can only be streamed once, so each test needs a fresh one.
const renderToolCallRound = () =>
  sse([
    {
      model: "z-ai/glm-5.2",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_render",
                function: {
                  name: "render_slide",
                  arguments: '{"deck_id":"deck-1","slide_id":"s1"}',
                },
              },
            ],
          },
        },
      ],
    },
  ]);

const imageInput404 = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "No endpoints found that support image input",
        code: 404,
      },
    }),
    { status: 404 },
  );

type ChatCallBody = {
  model: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }> | null;
  }>;
};

// Splits the stubbed fetch's calls into catalog lookups and chat completions,
// returning the parsed chat bodies in call order.
function chatBodies(fetchMock: ReturnType<typeof vi.fn>): ChatCallBody[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/chat/completions"))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as ChatCallBody);
}

function imagePartCount(body: ChatCallBody): number {
  return body.messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part) => part.type === "image_url").length;
}

beforeEach(() => {
  resetOpenRouterCatalogForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vision relay for text-only OpenRouter models", () => {
  it("routes the image round to the relay, then scrubs the images and returns to the primary", async () => {
    const { db, admin } = makeDb();
    const chatQueue = [
      renderToolCallRound(),
      // Relay round: inspects the image, makes one more (unknown) tool call so
      // a third round exists to prove control returns to the primary.
      sse([
        {
          model: "minimax/minimax-m3",
          choices: [
            {
              delta: {
                content: "The render looks correct. ",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_next",
                    function: { name: "unknown_canvas_tool", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      ]),
      sse([
        {
          model: "z-ai/glm-5.2",
          choices: [{ delta: { content: "All done." } }],
        },
      ]),
    ];
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/models")) {
        return catalogResponse([
          { id: "z-ai/glm-5.2", modalities: ["text"] },
          { id: "minimax/minimax-m3", modalities: ["text", "image"] },
        ]);
      }
      return chatQueue.shift() ?? sse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenRouterTurn(turnInput(admin, "z-ai/glm-5.2"));
    expect(result.status).toBe("complete");

    const bodies = chatBodies(fetchMock);
    expect(bodies.map((body) => body.model)).toEqual([
      "z-ai/glm-5.2",
      "minimax/minimax-m3",
      "z-ai/glm-5.2",
    ]);
    // The relay round carried the render; the primary's next round did not.
    expect(imagePartCount(bodies[1])).toBe(1);
    expect(imagePartCount(bodies[2])).toBe(0);
    const trace = bodies[2].messages.find(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("no longer attached"),
    );
    expect(trace).toBeDefined();
    expect(db.canvas_assistant_message[1].content).toBe(
      "The render looks correct. All done.",
    );
  });

  it("falls back to the relay when the catalog is silent and the provider 404s image input", async () => {
    const { admin } = makeDb();
    const chatQueue = [
      renderToolCallRound(),
      imageInput404(),
      sse([
        {
          model: "minimax/minimax-m3",
          choices: [{ delta: { content: "Render verified." } }],
        },
      ]),
    ];
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/models")) {
        // The dated id is not listed, so the gate cannot classify it.
        return catalogResponse([
          { id: "minimax/minimax-m3", modalities: ["text", "image"] },
        ]);
      }
      return chatQueue.shift() ?? sse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenRouterTurn(
      turnInput(admin, "z-ai/glm-5.2-20260616"),
    );
    expect(result.status).toBe("complete");

    const bodies = chatBodies(fetchMock);
    expect(bodies.map((body) => body.model)).toEqual([
      "z-ai/glm-5.2-20260616",
      "z-ai/glm-5.2-20260616",
      "minimax/minimax-m3",
    ]);
    // The relay retry kept the images so the inspection could still happen.
    expect(imagePartCount(bodies[2])).toBe(1);
  });

  it("strips the images and returns to the primary when the relay itself refuses them", async () => {
    const { admin } = makeDb();
    const chatQueue = [
      renderToolCallRound(),
      imageInput404(),
      sse([
        {
          model: "z-ai/glm-5.2",
          choices: [
            { delta: { content: "Proposal made; verify it in Review." } },
          ],
        },
      ]),
    ];
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/models")) {
        return catalogResponse([
          { id: "z-ai/glm-5.2", modalities: ["text"] },
          { id: "minimax/minimax-m3", modalities: ["text", "image"] },
        ]);
      }
      return chatQueue.shift() ?? sse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenRouterTurn(turnInput(admin, "z-ai/glm-5.2"));
    expect(result.status).toBe("complete");

    const bodies = chatBodies(fetchMock);
    expect(bodies.map((body) => body.model)).toEqual([
      "z-ai/glm-5.2",
      "minimax/minimax-m3",
      "z-ai/glm-5.2",
    ]);
    expect(imagePartCount(bodies[2])).toBe(0);
    const trace = bodies[2].messages.find(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("could not be shown"),
    );
    expect(trace).toBeDefined();
  });
});
