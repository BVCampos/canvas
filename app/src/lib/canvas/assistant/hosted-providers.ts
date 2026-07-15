// Hosted BYOK provider registry (ADR-0014): the one place that knows which
// API vendors the hosted assistant runtime accepts, what their keys and model
// ids look like, and how to validate a key+model pair at save time. Imported
// by both the Connections UI (presets, placeholders, links) and the server
// actions (validators) — keep it framework-free and browser-safe.

export type HostedProvider = "openrouter" | "anthropic" | "openai";

export type HostedModelPreset = { label: string; model: string; hint: string };

export type HostedProviderInfo = {
  label: string;
  keyPlaceholder: string;
  keyUrl: string;
  keyUrlLabel: string;
  defaultModel: string;
  presets: HostedModelPreset[];
  // Comma-separated fallback lists are an OpenRouter routing feature; the
  // native APIs take exactly one model id.
  allowsModelList: boolean;
};

export const HOSTED_PROVIDERS: Record<HostedProvider, HostedProviderInfo> = {
  openrouter: {
    label: "OpenRouter",
    keyPlaceholder: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyUrlLabel: "OpenRouter",
    defaultModel: "openrouter/auto",
    // Quick-pick model presets (speed discovery — assistant #6). The floor on
    // a reasoning model's turn is its thinking latency (~10s even for "hi"),
    // so a non-reasoning preset changes the felt speed class for small copy
    // tweaks; the heavier reasoning preset stays for redesigns. The "deep
    // work" value is a comma list — the runner sends the first id as primary
    // and the rest as OpenRouter's `models` fallback array, so a routing flap
    // on the pinned dated id fails over to the alias instead of killing the
    // turn (assistant #2). The field stays free-text; a preset just fills it.
    presets: [
      {
        label: "Balanced",
        model: "openrouter/auto",
        hint: "OpenRouter picks a capable model per request.",
      },
      {
        label: "Quick edits",
        model: "anthropic/claude-haiku-4.5",
        hint: "Fast, non-reasoning — best for small copy tweaks.",
      },
      {
        label: "Deep work",
        model: "z-ai/glm-5.2-20260616, z-ai/glm-5.2",
        hint: "Reasoning model for redesigns (pinned id, alias fallback).",
      },
    ],
    allowsModelList: true,
  },
  anthropic: {
    label: "Anthropic",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://platform.claude.com/",
    keyUrlLabel: "the Claude Platform console",
    defaultModel: "claude-sonnet-5",
    presets: [
      {
        label: "Balanced",
        model: "claude-sonnet-5",
        hint: "Near-Opus quality at Sonnet speed — the everyday pick.",
      },
      {
        label: "Quick edits",
        model: "claude-haiku-4-5",
        hint: "Fast and cheap — best for small copy tweaks.",
      },
      {
        label: "Deep work",
        model: "claude-opus-4-8",
        hint: "Most capable — for redesigns and hard multi-step work.",
      },
    ],
    allowsModelList: false,
  },
  openai: {
    label: "OpenAI",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlLabel: "OpenAI",
    defaultModel: "gpt-5.1",
    presets: [
      {
        label: "Balanced",
        model: "gpt-5.1",
        hint: "OpenAI's flagship — solid default for Canvas chat.",
      },
      {
        label: "Quick edits",
        model: "gpt-5-mini",
        hint: "Faster and cheaper — best for small copy tweaks.",
      },
      {
        label: "Deep work",
        model: "gpt-5.1",
        hint: "Same flagship at full depth for redesigns.",
      },
    ],
    allowsModelList: false,
  },
};

export function isHostedProvider(value: unknown): value is HostedProvider {
  return value === "openrouter" || value === "anthropic" || value === "openai";
}

// Native-API model ids: one bare id, no comma list, no OpenRouter owner/slug.
const NATIVE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type HostedModelSpecError = "invalid_model" | "fallback_list_unsupported";

/**
 * Model-spec rules per provider. OpenRouter keeps its comma-separated
 * fallback-list grammar (validated by the caller against owner/name slugs);
 * anthropic/openai must be a SINGLE bare model id — a comma list gets the
 * distinct `fallback_list_unsupported` error so the UI can explain rather
 * than emit a generic "invalid model".
 */
export function validateNativeModelSpec(
  value: string,
): { ok: true; modelId: string } | { ok: false; error: HostedModelSpecError } {
  const trimmed = value.trim();
  if (trimmed.includes(",")) return { ok: false, error: "fallback_list_unsupported" };
  if (!NATIVE_MODEL_ID_RE.test(trimmed)) return { ok: false, error: "invalid_model" };
  return { ok: true, modelId: trimmed };
}

export function hostedKeyHint(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

type FetchLike = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;

export type HostedValidationResult =
  | { ok: true; modelId: string; modelName: string | null; keyHint: string }
  | { ok: false; error: "invalid_key" | "model_not_capable" | "provider_unavailable" };

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

// GET /v1/models/{id} doubles as key check and model check: 401 can only mean
// a bad key, 404 can only mean the id isn't served to this key. Validation is
// the source of truth for model ids — a preset that stops resolving here is a
// preset to fix.
async function validateModelLookup(
  url: string,
  headers: Record<string, string>,
  modelId: string,
  readName: (body: unknown) => string | null,
  fetchImpl: FetchLike,
): Promise<HostedValidationResult> {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers,
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "invalid_key" };
    }
    if (response.status === 404) {
      return { ok: false, error: "model_not_capable" };
    }
    if (!response.ok) {
      return { ok: false, error: "provider_unavailable" };
    }
    let modelName: string | null = null;
    try {
      modelName = readName(await response.json());
    } catch {
      modelName = null;
    }
    return { ok: true, modelId, modelName, keyHint: "" };
  } catch {
    return { ok: false, error: "provider_unavailable" };
  }
}

export async function validateAnthropicAccess(
  apiKey: string,
  modelId: string,
  fetchImpl: FetchLike = fetch,
): Promise<HostedValidationResult> {
  const key = apiKey.trim();
  const result = await validateModelLookup(
    `https://api.anthropic.com/v1/models/${encodeURIComponent(modelId)}`,
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    modelId,
    (body) => {
      const name = (body as { display_name?: unknown })?.display_name;
      return typeof name === "string" ? name : null;
    },
    fetchImpl,
  );
  return result.ok ? { ...result, keyHint: hostedKeyHint(key) } : result;
}

export async function validateOpenAiAccess(
  apiKey: string,
  modelId: string,
  fetchImpl: FetchLike = fetch,
): Promise<HostedValidationResult> {
  const key = apiKey.trim();
  const result = await validateModelLookup(
    `https://api.openai.com/v1/models/${encodeURIComponent(modelId)}`,
    { Authorization: `Bearer ${key}` },
    modelId,
    (body) => {
      const id = (body as { id?: unknown })?.id;
      return typeof id === "string" ? id : null;
    },
    fetchImpl,
  );
  return result.ok ? { ...result, keyHint: hostedKeyHint(key) } : result;
}
