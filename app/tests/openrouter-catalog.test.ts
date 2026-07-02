import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  modelAcceptsImageInput,
  resetOpenRouterCatalogForTests,
} from "../src/lib/canvas/assistant/openrouter-catalog";

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

const CATALOG = [
  { id: "z-ai/glm-5.2", modalities: ["text"] },
  { id: "minimax/minimax-m3", modalities: ["text", "image"] },
];

beforeEach(() => {
  resetOpenRouterCatalogForTests();
});

describe("OpenRouter model catalog", () => {
  it("classifies image-capable, text-only, and unlisted models", async () => {
    const fetchMock = vi.fn(async () => catalogResponse(CATALOG));
    await expect(
      modelAcceptsImageInput("minimax/minimax-m3", fetchMock as typeof fetch),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput("z-ai/glm-5.2", fetchMock as typeof fetch),
    ).resolves.toBe(false);
    await expect(
      modelAcceptsImageInput("unknown/model", fetchMock as typeof fetch),
    ).resolves.toBeNull();
  });

  it("fetches the catalog once and serves later lookups from cache", async () => {
    const fetchMock = vi.fn(async () => catalogResponse(CATALOG));
    await modelAcceptsImageInput("z-ai/glm-5.2", fetchMock as typeof fetch);
    await modelAcceptsImageInput("minimax/minimax-m3", fetchMock as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves routing-suffix variants through the bare model id", async () => {
    const fetchMock = vi.fn(async () => catalogResponse(CATALOG));
    await expect(
      modelAcceptsImageInput("minimax/minimax-m3:nitro", fetchMock as typeof fetch),
    ).resolves.toBe(true);
    await expect(
      modelAcceptsImageInput("z-ai/glm-5.2:floor", fetchMock as typeof fetch),
    ).resolves.toBe(false);
  });

  it("returns null when the catalog is unreachable, then recovers on the next call", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(catalogResponse(CATALOG));
    await expect(
      modelAcceptsImageInput("z-ai/glm-5.2", fetchMock as typeof fetch),
    ).resolves.toBeNull();
    await expect(
      modelAcceptsImageInput("z-ai/glm-5.2", fetchMock as typeof fetch),
    ).resolves.toBe(false);
  });
});
