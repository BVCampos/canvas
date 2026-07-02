// MCP token lifetime helpers.
//
// Tokens used to live forever — minted once, valid until a human remembered to
// revoke. These add a default expiry to NEW tokens and a rotation path, so a
// leaked or stale token has a bounded blast radius. Legacy tokens (minted before
// expiry existed) carry a null expires_at and never expire, for back-compat —
// the lookup paths treat null as "no expiry".
//
// NOTE: this is the SAFE, additive half of the token-hardening item. Hashing the
// token at rest (so a DB read leak doesn't hand over live secrets) needs a
// destructive primary-key migration that can't be verified without the prod DB,
// so it's deferred — see docs/discovery/improvement-map-execution.md.

export const MCP_TOKEN_TTL_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

// ISO expiry timestamp for a token minted now.
export function mcpTokenExpiresAt(nowMs: number = Date.now()): string {
  return new Date(nowMs + MCP_TOKEN_TTL_DAYS * DAY_MS).toISOString();
}

// True only when a token has a SET expiry that is already in the past. A null /
// undefined expires_at (legacy token) is never expired.
export function isMcpTokenExpired(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t < nowMs;
}
