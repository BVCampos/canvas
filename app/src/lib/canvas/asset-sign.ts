// Signed asset URLs.
//
// The deck preview iframe is sandboxed to an opaque origin (`allow-scripts`
// without `allow-same-origin`) so untrusted deck JS can't reach the app origin.
// A side effect: the iframe's `<img>` subresource requests to
// `/api/canvas/asset/{id}` are treated as cross-site, so the SameSite=Lax auth
// cookie is withheld and the normal cookie+RLS check on the asset route would
// 401. To keep assets loading, the preview route — which has ALREADY passed RLS
// for the deck — signs each asset id with an HMAC; the asset route accepts a
// valid, unexpired signature as proof of authorization in lieu of the cookie.
//
// A signature authorizes reading exactly one asset id for the window below.
// It can only be produced server-side (needs the signing key) and is only ever
// emitted for assets the requesting user was already entitled to read.

import { createHmac, timingSafeEqual } from "crypto";

// Dedicated signing key, falling back to the service-role secret if unset so
// nothing breaks on deploy. Decoupling them matters for two reasons: (1) the day
// SUPABASE_SECRET_KEY is rotated (routine hygiene, or forced after a leak) every
// previously-signed asset URL would otherwise silently 401, turning a credential
// rotation into a visible deck-image outage that discourages rotating; (2) the
// full-DB-god-mode secret stops doubling as a URL-signing key. Set
// CANVAS_ASSET_SIGNING_KEY to any 32+ random bytes to use it; both keys can then
// be rotated independently. The key never leaves the server; only the derived
// signature is exposed in the URL.
const SIGNING_SECRET =
  process.env.CANVAS_ASSET_SIGNING_KEY || process.env.SUPABASE_SECRET_KEY || "";

// Forward-rounded expiry window. Repeated previews within the window produce an
// identical URL (so the immutable HTTP cache still hits) while the signature
// still expires within ~1–2h.
const WINDOW_MS = 60 * 60 * 1000;

function sign(assetId: string, exp: number): string {
  return createHmac("sha256", SIGNING_SECRET)
    .update(`${assetId}.${exp}`)
    .digest("base64url");
}

// Query string (no leading `?`) authorizing `assetId`, rounded for cacheability.
export function assetSigQuery(assetId: string, nowMs: number): string {
  const exp = (Math.floor(nowMs / WINDOW_MS) + 2) * WINDOW_MS;
  return `exp=${exp}&sig=${sign(assetId, exp)}`;
}

export function verifyAssetSig(
  assetId: string,
  exp: string | null,
  sig: string | null,
  nowMs: number,
): boolean {
  if (!SIGNING_SECRET || !exp || !sig) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < nowMs) return false;
  const expected = sign(assetId, expMs);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
