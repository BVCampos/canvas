import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000002";

let ownedRow: Record<string, unknown> | null;
let insertedAssistant: Record<string, unknown> | null;

class AdminBuilder {
  private operation: "select" | "update" | "insert" = "select";
  private values: Record<string, unknown> = {};

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.values = values;
    return this;
  }
  insert(values: Record<string, unknown>) {
    this.operation = "insert";
    this.values = values;
    insertedAssistant = values;
    return this;
  }
  select() {
    return this;
  }
  eq() {
    return this;
  }
  async maybeSingle() {
    if (this.operation === "update" && this.values.status === "running") {
      return {
        data: {
          id: MESSAGE_ID,
          deck_id: "deck-1",
          workspace_id: "workspace-1",
          thread_id: "thread-1",
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }
  async single() {
    if (this.operation === "insert") {
      return { data: { id: "assistant-1" }, error: null };
    }
    return { data: null, error: null };
  }
  then<T>(onFulfilled?: (value: { data: null; error: null }) => T) {
    return Promise.resolve({ data: null, error: null }).then(onFulfilled);
  }
}

const authBuilder = {
  select() {
    return this;
  },
  eq() {
    return this;
  },
  maybeSingle: async () => ({ data: ownedRow, error: null }),
};

const authClient = {
  auth: {
    getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
  },
  from: () => authBuilder,
};
const adminClient = { from: () => new AdminBuilder() };
const runner = vi.fn(async (input: unknown) => {
  void input;
  return {
    status: "complete" as const,
    model: "anthropic/test",
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => authClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClient,
}));
vi.mock("@/lib/canvas/rate-limit", () => ({
  rateLimitOk: vi.fn(async () => true),
}));
vi.mock("@/lib/canvas/assistant/openrouter-config", () => ({
  getOpenRouterCredential: vi.fn(async () => ({
    apiKey: "sk-or-v1-test",
    modelId: "openrouter/auto",
  })),
}));
vi.mock("@/lib/canvas/assistant/openrouter-runner", () => ({
  runOpenRouterTurn: (input: unknown) => runner(input),
}));
vi.mock("@/lib/usage/log", () => ({ logUsage: vi.fn() }));

import { POST } from "../src/app/api/assistant/openrouter/run/route";

function request(origin = "http://localhost:3001", host = "localhost:3001") {
  return new NextRequest("http://localhost:3001/api/assistant/openrouter/run", {
    method: "POST",
    headers: {
      Origin: origin,
      Host: host,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_message_id: MESSAGE_ID }),
  });
}

afterEach(() => {
  ownedRow = {
    id: MESSAGE_ID,
    deck_id: "deck-1",
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    role: "user",
    status: "queued",
    execution_runtime: "openrouter",
  };
  insertedAssistant = null;
  runner.mockClear();
});

ownedRow = {
  id: MESSAGE_ID,
  deck_id: "deck-1",
  workspace_id: "workspace-1",
  thread_id: "thread-1",
  role: "user",
  status: "queued",
  execution_runtime: "openrouter",
};

describe("POST /api/assistant/openrouter/run", () => {
  it("claims only the caller's OpenRouter prompt and stamps the reply runtime", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "complete" });
    expect(insertedAssistant).toMatchObject({
      role: "assistant",
      status: "streaming",
      execution_runtime: "openrouter",
      user_id: USER_ID,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][0]).toMatchObject({
      userMessageId: MESSAGE_ID,
      assistantMessageId: "assistant-1",
      userId: USER_ID,
    });
  });

  it("rejects cross-origin requests before auth or provider cost", async () => {
    const response = await POST(request("https://evil.example"));
    expect(response.status).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses a local-bridge row", async () => {
    ownedRow = { ...ownedRow, execution_runtime: "bridge" };
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "wrong_runtime" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not reveal a prompt hidden by RLS", async () => {
    ownedRow = null;
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
    expect(runner).not.toHaveBeenCalled();
  });
});
