import "server-only";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openrouter/auto";
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

export type OpenRouterValidationResult =
  | {
      ok: true;
      modelId: string;
      modelName: string | null;
      keyHint: string;
    }
  | {
      ok: false;
      error:
        | "invalid_key"
        | "model_not_capable"
        | "openrouter_unavailable";
    };

export function normalizeOpenRouterModel(value: string): string {
  const model = value.trim();
  return model || DEFAULT_MODEL;
}

const MODEL_SLUG_RE = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/;

// A stored model_id may be a comma-separated PREFERENCE list
// ("z-ai/glm-5.2-20260616, z-ai/glm-5.2"): the first entry is the primary and
// the rest ride OpenRouter's `models` fallback array, so a routing flap on one
// id fails over server-side instead of killing the turn. This is the single
// parser both the settings validator and the turn runner use, so the two can't
// disagree on what "primary" and "fallbacks" mean.
export function parseOpenRouterModels(value: string): {
  primary: string;
  models: string[];
  normalized: string;
} {
  const models = value
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const primary = models[0] ?? DEFAULT_MODEL;
  return { primary, models, normalized: models.join(", ") };
}

// Every entry in a model spec must be a valid "owner/name" slug.
export function isValidOpenRouterModelSpec(value: string): boolean {
  const { models } = parseOpenRouterModels(value);
  return models.length > 0 && models.every((m) => MODEL_SLUG_RE.test(m));
}

export function openRouterKeyHint(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate the personal key and ensure a custom model can call tools. Image
 * input is welcome but no longer required: rounds that carry Canvas render
 * images are rerouted to the vision relay when the chosen model is text-only
 * (see VISION_RELAY_MODEL in openrouter-runner.ts). `openrouter/auto` is
 * capability-routed from the actual request, so key validation is sufficient
 * for that special router.
 */
export async function validateOpenRouterAccess(
  apiKey: string,
  requestedModel: string,
  fetchImpl: FetchLike = fetch,
): Promise<OpenRouterValidationResult> {
  const key = apiKey.trim();
  const modelId = normalizeOpenRouterModel(requestedModel);
  const headers = { Authorization: `Bearer ${key}` };

  try {
    const keyResponse = await fetchWithTimeout(
      fetchImpl,
      `${OPENROUTER_API}/key`,
      { headers, cache: "no-store" },
    );
    if (keyResponse.status === 401 || keyResponse.status === 403) {
      return { ok: false, error: "invalid_key" };
    }
    if (!keyResponse.ok) {
      return { ok: false, error: "openrouter_unavailable" };
    }

    if (modelId === DEFAULT_MODEL) {
      return {
        ok: true,
        modelId,
        modelName: "Auto (tool + vision capable)",
        keyHint: openRouterKeyHint(key),
      };
    }

    const params = new URLSearchParams({
      supported_parameters: "tools",
      output_modalities: "text",
    });
    const modelsResponse = await fetchWithTimeout(
      fetchImpl,
      `${OPENROUTER_API}/models/user?${params.toString()}`,
      { headers, cache: "no-store" },
    );
    if (modelsResponse.status === 401 || modelsResponse.status === 403) {
      return { ok: false, error: "invalid_key" };
    }
    if (!modelsResponse.ok) {
      return { ok: false, error: "openrouter_unavailable" };
    }
    const body = (await modelsResponse.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
    };
    const model = body.data?.find((entry) => entry.id === modelId);
    if (!model) return { ok: false, error: "model_not_capable" };

    return {
      ok: true,
      modelId,
      modelName: typeof model.name === "string" ? model.name : null,
      keyHint: openRouterKeyHint(key),
    };
  } catch {
    return { ok: false, error: "openrouter_unavailable" };
  }
}

