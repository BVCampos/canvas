import { describe, expect, it, vi } from "vitest";
import {
  HOSTED_PROVIDERS,
  validateAnthropicAccess,
  validateNativeModelSpec,
  validateOpenAiAccess,
} from "../src/lib/canvas/assistant/hosted-providers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateNativeModelSpec (anthropic/openai model-spec rules)", () => {
  it("accepts a single bare model id, trimmed", () => {
    expect(validateNativeModelSpec("  claude-sonnet-5 ")).toEqual({
      ok: true,
      modelId: "claude-sonnet-5",
    });
    expect(validateNativeModelSpec("gpt-5.1")).toEqual({ ok: true, modelId: "gpt-5.1" });
  });

  it("rejects comma-separated fallback lists with the DISTINCT error", () => {
    // Fallback lists are an OpenRouter routing feature; the UI explains that
    // rather than showing a generic invalid-model message.
    expect(validateNativeModelSpec("claude-sonnet-5, claude-haiku-4-5")).toEqual({
      ok: false,
      error: "fallback_list_unsupported",
    });
  });

  it("rejects empty and malformed ids", () => {
    expect(validateNativeModelSpec("")).toEqual({ ok: false, error: "invalid_model" });
    expect(validateNativeModelSpec("has spaces")).toEqual({
      ok: false,
      error: "invalid_model",
    });
  });

  it("every anthropic/openai preset passes its own spec rule", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      for (const preset of HOSTED_PROVIDERS[provider].presets) {
        expect(validateNativeModelSpec(preset.model)).toEqual({
          ok: true,
          modelId: preset.model,
        });
      }
    }
  });
});

describe("validateAnthropicAccess", () => {
  it("validates key+model via GET /v1/models/{id} with Anthropic headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }),
    );
    const result = await validateAnthropicAccess(
      "sk-ant-test-abcd",
      "claude-sonnet-5",
      fetchMock as typeof fetch,
    );
    expect(result).toEqual({
      ok: true,
      modelId: "claude-sonnet-5",
      modelName: "Claude Sonnet 5",
      keyHint: "••••abcd",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.anthropic.com/v1/models/claude-sonnet-5",
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      "x-api-key": "sk-ant-test-abcd",
      "anthropic-version": "2023-06-01",
    });
  });

  it("maps 401 to invalid_key and 404 to model_not_capable", async () => {
    const unauthorized = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "bad key" }, 401),
    );
    await expect(
      validateAnthropicAccess("bad", "claude-sonnet-5", unauthorized as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "invalid_key" });

    const missing = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "not found" }, 404),
    );
    await expect(
      validateAnthropicAccess("sk-ant-x", "claude-nope", missing as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "model_not_capable" });
  });

  it("maps 5xx and network failures to provider_unavailable", async () => {
    const down = vi.fn<typeof fetch>(async () => jsonResponse({}, 529));
    await expect(
      validateAnthropicAccess("sk-ant-x", "claude-sonnet-5", down as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "provider_unavailable" });

    const network = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      validateAnthropicAccess("sk-ant-x", "claude-sonnet-5", network as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "provider_unavailable" });
  });
});

describe("validateOpenAiAccess", () => {
  it("validates key+model via GET /v1/models/{id} with a bearer header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: "gpt-5.1", object: "model" }),
    );
    const result = await validateOpenAiAccess(
      "sk-test-wxyz",
      "gpt-5.1",
      fetchMock as typeof fetch,
    );
    expect(result).toEqual({
      ok: true,
      modelId: "gpt-5.1",
      modelName: "gpt-5.1",
      keyHint: "••••wxyz",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/models/gpt-5.1",
    );
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      Authorization: "Bearer sk-test-wxyz",
    });
  });

  it("maps 403 to invalid_key and 404 to model_not_capable", async () => {
    const forbidden = vi.fn<typeof fetch>(async () => jsonResponse({}, 403));
    await expect(
      validateOpenAiAccess("sk-x", "gpt-5.1", forbidden as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "invalid_key" });

    const missing = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    await expect(
      validateOpenAiAccess("sk-x", "gpt-nope", missing as typeof fetch),
    ).resolves.toEqual({ ok: false, error: "model_not_capable" });
  });
});
