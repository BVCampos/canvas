// Deterministic per-user avatar gradient.
//
// The previous treatment was a solid ink circle on every avatar, which left
// the heaviest visual element on the topbar identical for every member of the
// workspace. This utility derives a stable second color from the user's email
// and combines it with the project's ink/graphite as a fixed dark anchor, so
// each member gets a recognizable but on-brand swatch.
//
// Stability matters here — the same email must always resolve to the same
// gradient so the avatar reads as a consistent identity cue across sessions
// and across surfaces (topbar, dropdown header, presence stack).

// Curated palette of accent colors that complement the ink anchor. Pulled
// from globals.css. We intentionally avoid --warning (amber) and --danger
// (red) — those carry stale / destructive semantics elsewhere in the UI and
// would mis-signal on an avatar.
const AVATAR_PALETTE = [
  "var(--accent)",
  "var(--accent-warm)",
  "var(--success)",
  "var(--copper-deep)",
  "var(--accent-dim)",
  "var(--graphite)",
] as const;

// Simple, deterministic char-code sum modulo palette length. Not a real hash
// — collisions are fine. We just need the same email to land on the same
// index every time, and to spread reasonably across a small workspace.
function hashEmail(email: string): number {
  const normalized = (email || "").trim().toLowerCase();
  if (!normalized) return 0;
  let sum = 0;
  for (let i = 0; i < normalized.length; i++) {
    sum += normalized.charCodeAt(i);
  }
  return sum % AVATAR_PALETTE.length;
}

// CSS `background` value: a linear gradient from the project's dark anchor
// to a per-user accent. Safe to pass to a React `style.background`.
export function avatarGradient(email: string): string {
  const accent = AVATAR_PALETTE[hashEmail(email)];
  return `linear-gradient(135deg, var(--ink) 0%, var(--graphite) 45%, ${accent} 100%)`;
}

// Inner ring used in conjunction with the gradient to soften the circle's
// edge and lift it off the topbar. Pair with the gradient on `background` —
// box-shadow can stack with the gradient without clobbering it.
export const AVATAR_INNER_RING = "inset 0 0 0 1px rgba(255, 255, 255, 0.18)";
