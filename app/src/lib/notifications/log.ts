// Server-side notification writer — inserts into public.canvas_notification.
//
// Mirrors usage/log.ts: writes go through the service-role admin client because
// canvas_notification has NO client INSERT policy (rows are written on behalf
// of the actor, not under the recipient's RLS context — see migration 0048).
// Best-effort and fire-and-forget: a notification failure must never break the
// comment that triggered it, exactly like logUsage. Errors surface only as a
// console warning.

import { createAdminClient } from "@/lib/supabase/admin";
import type { NotificationInsert } from "@/lib/canvas/notifications";

// Test seam — production goes through createAdminClient(); unit tests swap this
// to assert what was inserted without hitting Supabase. (Same shape as the
// usage logger's factory seam.)
let clientFactory: () => ReturnType<typeof createAdminClient> = createAdminClient;

export function __setNotificationClientFactoryForTesting(
  factory: () => ReturnType<typeof createAdminClient>,
): void {
  clientFactory = factory;
}

export function __resetNotificationClientFactoryForTesting(): void {
  clientFactory = createAdminClient;
}

// Fire-and-forget batch insert. No-op on an empty list so a comment with no
// recipients pays nothing. Never throws — the caller's comment already
// succeeded by the time we run.
export function logNotifications(rows: NotificationInsert[]): void {
  if (rows.length === 0) return;
  // Skip in the test environment unless explicitly opted in, mirroring
  // logUsage — unit tests for the pure resolver don't need this side effect.
  if (
    process.env.NODE_ENV === "test" &&
    !process.env.NOTIFICATIONS_ENABLED_IN_TEST
  ) {
    return;
  }
  void insert(rows).catch((err) => {
    console.error("[notifications:logNotifications]", err);
  });
}

async function insert(rows: NotificationInsert[]): Promise<void> {
  const { error } = await clientFactory().from("canvas_notification").insert(rows);
  if (error) throw error;
}
