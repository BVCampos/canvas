import type { SupabaseClient } from "@supabase/supabase-js";

// Sanitizes a `next` redirect target at the trust boundary: only same-origin
// absolute paths are allowed (must start with "/" but not "//", which the
// browser treats as a protocol-relative URL to another host). Returns null for
// anything else. Use this everywhere a caller-supplied `next` is consumed
// (login page, magic-link email link, OAuth cookie) so an open-redirect /
// phishing target can never be propagated.
export function safeNextPath(next: string | null | undefined): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

// Proxy's optimistic auth redirect covers only signed-in product pages, never
// APIs or public/login routes. Keeping this decision pure makes the exact deep
// link preservation testable without mocking Next/Supabase request objects.
export function protectedPageNextPath(
  pathname: string,
  search = "",
): string | null {
  const protectedPath = ["/canvases", "/settings"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!protectedPath) return null;
  return `${pathname}${search}`;
}

// Decides where to send an authenticated user after sign-in.
//
// Priority:
//   1. An explicit `next` param (e.g., they were trying to reach a deep link).
//   2. The first Workspace they're a member of (oldest first).
//   3. /no-workspace if they have zero memberships.
//
// Canvas uses a single global URL space — no /w/{slug}/ prefix in v0. The
// active workspace is resolved server-side from the user's first membership.
export async function resolveAfterSignInRedirect(
  supabase: SupabaseClient,
  next: string | null,
): Promise<string> {
  const safe = safeNextPath(next);
  if (safe) {
    return safe;
  }

  const { data: memberships } = await supabase
    .from("workspace_memberships")
    .select("workspace_id")
    .order("joined_at", { ascending: true })
    .limit(1);

  return memberships?.[0] ? "/canvases" : "/no-workspace";
}
