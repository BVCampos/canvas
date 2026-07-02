"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Mark-read server actions for the notification feed. Writes go through the
// user's RLS-aware client — the "users update own notifications" policy
// (migration 0048) is the authoritative gate, so a caller can only ever flip
// their OWN rows. A non-owner's UPDATE simply matches zero rows.

export type ActionResult = { ok: true } | { ok: false; error: string };

// Mark a single notification read (per-row read-on-click). Idempotent: setting
// read_at on an already-read row is harmless. We scope the UPDATE to the row id
// AND the unread predicate so re-stamping a read row is a no-op, and RLS scopes
// it to the caller's own rows.
export async function markNotificationRead(
  notificationId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { error } = await supabase
    .from("canvas_notification")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .is("read_at", null);

  if (error) {
    console.error("[markNotificationRead]", error);
    return { ok: false, error: error.message };
  }

  // Refresh the feed + every /canvases page so the topbar badge recount picks
  // up the change.
  revalidatePath("/canvases/notifications");
  revalidatePath("/canvases", "layout");
  return { ok: true };
}

// "Mark all read" — flip every still-unread notification for the caller. The
// `is("read_at", null)` predicate keeps it cheap (only the unread rows) and
// matches the partial index; RLS scopes it to the caller's own rows so we
// don't need a user_id filter (but the policy's user_id = auth.uid() is the
// real gate).
export async function markAllNotificationsRead(): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { error } = await supabase
    .from("canvas_notification")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);

  if (error) {
    console.error("[markAllNotificationsRead]", error);
    return { ok: false, error: error.message };
  }

  revalidatePath("/canvases/notifications");
  revalidatePath("/canvases", "layout");
  return { ok: true };
}
