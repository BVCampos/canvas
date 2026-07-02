import type { SupabaseClient } from "@supabase/supabase-js";

// How the limiter behaves when the underlying RPC errors or throws:
//   - "open"   → return ALLOWED (default). A limiter hiccup degrades to "no
//                limit" so it can never take an endpoint down. Right for
//                authenticated paths (a signed-in user is already behind it).
//   - "closed" → return DENIED. Right for fully-unauthenticated public surfaces
//                where the limiter is the ONLY throttle: a DB hiccup must not
//                evaporate the cap exactly when the system is under load.
export type RateLimitFailureMode = "open" | "closed";

// DB-backed fixed-window rate limit (see migration 0022). Returns true if the
// request is ALLOWED. Must be called with the service-role admin client — the
// underlying function is service-role-only.
export async function rateLimitOk(
  admin: SupabaseClient,
  bucket: string,
  max: number,
  windowSeconds: number,
  failureMode: RateLimitFailureMode = "open",
): Promise<boolean> {
  const onFailure = failureMode === "open";
  try {
    const { data, error } = await admin.rpc("canvas_rate_limit_hit", {
      _bucket: bucket,
      _max: max,
      _window_seconds: windowSeconds,
    });
    if (error) {
      console.error("[rate-limit]", bucket, error.message);
      return onFailure;
    }
    return data !== false;
  } catch (err) {
    console.error("[rate-limit]", bucket, err);
    return onFailure;
  }
}
