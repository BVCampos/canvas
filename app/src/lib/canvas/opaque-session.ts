// Opaque per-browser session id — a persistent, cookieless, PII-free key
// minted client-side and kept in localStorage. Two independent identities ride
// on the same shape under DIFFERENT storage keys (guest comments vs. view
// tracking), so each caller passes its own storage key and per-load fallback
// prefix; the identities stay separate on purpose. Reuses a stored id only
// when it still matches the shared SESSION_RE contract; on storage denial
// (private mode) returns a fresh per-load id that can't persist.
//
// DOM/crypto is touched only inside the function body, so importing this module
// is side-effect-free — call it from client code (effects/handlers), never SSR.

import { SESSION_RE } from "@/lib/canvas/engagement";

export function mintOpaqueSession(storageKey: string, fallbackPrefix: string): string {
  const fresh = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${fallbackPrefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing && SESSION_RE.test(existing)) return existing;
    const minted = fresh();
    window.localStorage.setItem(storageKey, minted);
    return minted;
  } catch {
    // Private mode / storage denied — a per-load id that can't persist.
    return fresh();
  }
}
