// Trusted client-IP extraction for self-hosted (EC2 + Cloudflare Tunnel).
//
// THREAT: the public preview routes keyed their per-IP rate-limit bucket off the
// FIRST value of X-Forwarded-For. On the self-host origin that header is fully
// client-controllable — an attacker rotates a fake `X-Forwarded-For:` per
// request and the per-IP cap never trips, defeating the only throttle on an
// unauthenticated route that re-assembles the whole deck on every hit.
//
// FIX: trust only headers the trusted front door (Cloudflare) sets and a client
// cannot forge end-to-end:
//   1. `CF-Connecting-IP` — Cloudflare overwrites this with the real client IP
//      on every request through the tunnel. This is the canonical, unspoofable
//      source for our deployment (mirrors the Host-header pinning in PR#51/#52).
//   2. `X-Real-IP` — set by a trusted reverse proxy if one is in front.
//
// We deliberately do NOT fall back to raw X-Forwarded-For: a value an attacker
// controls is worse than no value, because it lets them mint unlimited distinct
// buckets. When no trusted header is present, callers should fall back to a
// non-IP bucket (e.g. per-share-token) so the cap stays meaningful — see the
// public preview routes.
//
// Returns null when no trusted client IP can be determined.
export function trustedClientIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return null;
}
