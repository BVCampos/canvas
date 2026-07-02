import "server-only";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
// The catalog moves slowly (models appear/disappear over days) and every image
// round consults it, so one fetch per hour per process is plenty.
const CATALOG_TTL_MS = 60 * 60 * 1000;

type Catalog = {
  fetchedAt: number;
  ids: Set<string>;
  imageInput: Set<string>;
};

let catalog: Catalog | null = null;
let inflight: Promise<Catalog | null> | null = null;

async function loadCatalog(fetchImpl: typeof fetch): Promise<Catalog | null> {
  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        architecture?: { input_modalities?: unknown };
      }>;
    };
    if (!Array.isArray(body.data) || body.data.length === 0) return null;
    const ids = new Set<string>();
    const imageInput = new Set<string>();
    for (const model of body.data) {
      if (typeof model.id !== "string") continue;
      ids.add(model.id);
      const modalities = model.architecture?.input_modalities;
      if (Array.isArray(modalities) && modalities.includes("image")) {
        imageInput.add(model.id);
      }
    }
    return { fetchedAt: Date.now(), ids, imageInput };
  } catch {
    return null;
  }
}

/**
 * Whether the model accepts image_url content parts, per OpenRouter's public
 * model catalog. Returns `null` for "unknown" (catalog unreachable, or the id
 * is not listed): callers should send the images and rely on their reactive
 * fallback rather than guess. A stale catalog is kept serving when a refresh
 * fails.
 */
export async function modelAcceptsImageInput(
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  if (!catalog || Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) {
    inflight ??= loadCatalog(fetchImpl).finally(() => {
      inflight = null;
    });
    const fresh = await inflight;
    if (fresh) catalog = fresh;
  }
  if (!catalog) return null;
  // Routing-suffix variants ("z-ai/glm-4.6v:nitro") list under the bare id.
  const bareId = modelId.split(":")[0];
  if (catalog.imageInput.has(modelId) || catalog.imageInput.has(bareId)) {
    return true;
  }
  if (catalog.ids.has(modelId) || catalog.ids.has(bareId)) return false;
  return null;
}

export function resetOpenRouterCatalogForTests(): void {
  catalog = null;
  inflight = null;
}
