// Brand kit (v0) — pure helpers shared by the settings form, the read_brand
// MCP tool, and the assistant's context injection. No Supabase, no React:
// this module only shapes and summarizes the token bag stored on
// public.canvas_brand (migration 0065).

export type BrandTokens = {
  // Named hex colors: accent, ink, surface, muted, … Free-form names; the
  // conventional four are what the settings form edits directly.
  colors?: Record<string, string>;
  // Font stacks by role: sans, display, mono.
  fonts?: Record<string, string>;
};

export type BrandRow = {
  name: string | null;
  tokens: BrandTokens;
  voice: string | null;
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_NAME = 60;
const MAX_TOKEN_KEY = 40;
const MAX_TOKEN_VALUE = 200;
const MAX_VOICE = 4000;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value.trim());
}

// Validate + clamp an untrusted token bag (the settings form posts one, and
// old rows may hold anything). Drops malformed entries instead of erroring —
// a brand with one bad swatch should keep its good ones.
export function normalizeBrandTokens(raw: unknown): BrandTokens {
  const out: BrandTokens = {};
  if (typeof raw !== "object" || raw === null) return out;
  const bag = raw as Record<string, unknown>;

  if (typeof bag.colors === "object" && bag.colors !== null) {
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(bag.colors as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const k = key.trim().toLowerCase().slice(0, MAX_TOKEN_KEY);
      const v = value.trim();
      if (k === "" || !isHexColor(v)) continue;
      colors[k] = v.toLowerCase();
    }
    if (Object.keys(colors).length > 0) out.colors = colors;
  }

  if (typeof bag.fonts === "object" && bag.fonts !== null) {
    const fonts: Record<string, string> = {};
    for (const [key, value] of Object.entries(bag.fonts as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const k = key.trim().toLowerCase().slice(0, MAX_TOKEN_KEY);
      const v = value.trim().slice(0, MAX_TOKEN_VALUE);
      if (k === "" || v === "") continue;
      fonts[k] = v;
    }
    if (Object.keys(fonts).length > 0) out.fonts = fonts;
  }

  return out;
}

export function normalizeBrandName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_NAME);
  return trimmed === "" ? null : trimmed;
}

export function normalizeBrandVoice(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, MAX_VOICE);
  return trimmed === "" ? null : trimmed;
}

// The compact one-liner the assistant carries on EVERY turn (BYO-token cost —
// keep it tiny; the full set stays behind read_brand). Returns null when the
// brand is effectively empty so callers skip the preamble entirely.
const BLURB_VOICE_MAX = 240;

export function buildBrandBlurb(brand: BrandRow | null): string | null {
  if (!brand) return null;
  const parts: string[] = [];

  const colors = brand.tokens.colors ?? {};
  const colorEntries = Object.entries(colors);
  if (colorEntries.length > 0) {
    parts.push(
      `colors: ${colorEntries
        .slice(0, 8)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  }

  const fonts = brand.tokens.fonts ?? {};
  const fontEntries = Object.entries(fonts);
  if (fontEntries.length > 0) {
    parts.push(
      `fonts: ${fontEntries
        .slice(0, 4)
        .map(([k, v]) => `${k} ${v.split(",")[0].trim()}`)
        .join(", ")}`,
    );
  }

  if (brand.voice) {
    const oneLine = brand.voice.replace(/\s+/g, " ").trim();
    if (oneLine !== "") {
      parts.push(
        `voice: ${oneLine.length > BLURB_VOICE_MAX ? `${oneLine.slice(0, BLURB_VOICE_MAX - 1)}…` : oneLine}`,
      );
    }
  }

  if (parts.length === 0) return null;
  const label = brand.name ? `${brand.name} — ` : "";
  return `${label}${parts.join(" · ")}`;
}
