import { describe, expect, it, vi } from "vitest";
import {
  normalizeOpenRouterModel,
  validateOpenRouterAccess,
} from "../src/lib/canvas/assistant/openrouter-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenRouter connection validation", () => {
  it("validates openrouter/auto with the current-key endpoint only", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: { limit: null } }),
    );
    const result = await validateOpenRouterAccess(
      "sk-or-v1-abcdefghijkl",
      "",
      fetchMock as typeof fetch,
    );
    expect(result).toMatchObject({
      ok: true,
      modelId: "openrouter/auto",
      keyHint: "••••ijkl",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/key");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer sk-or-v1-abcdefghijkl",
    });
  });

  it("rejects an invalid key without attempting model discovery", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "bad" }, 401),
    );
    await expect(
      validateOpenRouterAccess("bad-key", "openrouter/auto", fetchMock as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "invalid_key" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a custom model from the tools-filtered model list (vision not required — the runner relays image rounds)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }],
        }),
      );
    const result = await validateOpenRouterAccess(
      "sk-or-v1-custom",
      "anthropic/claude-sonnet-4",
      fetchMock as typeof fetch,
    );
    expect(result).toMatchObject({
      ok: true,
      modelId: "anthropic/claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
    expect(fetchMock.mock.calls[1][0]).toContain("supported_parameters=tools");
    expect(fetchMock.mock.calls[1][0]).not.toContain("input_modalities");
  });

  it("rejects a custom model absent from the capable-model response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(
      validateOpenRouterAccess(
        "sk-or-v1-custom",
        "no-tools/model",
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({ ok: false, error: "model_not_capable" });
  });

  it("normalizes a blank model to the capability router", () => {
    expect(normalizeOpenRouterModel("  ")).toBe("openrouter/auto");
  });
});
