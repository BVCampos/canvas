"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_WORKSPACE_COOKIE, getActiveWorkspace } from "@/lib/auth/workspace";
import { logUsage } from "@/lib/usage/log";

// Sets the user's active workspace by writing a cookie that getActiveWorkspace
// consults. We re-verify membership server-side before persisting — never
// trust the workspaceId arriving from the client.
//
// Returns { ok } shapes so the client can show inline errors without a throw.
export async function setActiveWorkspaceAction(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const { data: membership, error } = await supabase
    .from("workspace_memberships")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    logUsage({
      event: "workspace.set_active",
      surface: "action",
      user_id: user.id,
      workspace_id: workspaceId,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "membership_lookup_failed",
    });
    return { ok: false, error: error.message };
  }
  if (!membership) {
    logUsage({
      event: "workspace.set_active",
      surface: "action",
      user_id: user.id,
      workspace_id: workspaceId,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_a_member",
    });
    return { ok: false, error: "not_a_member" };
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // Long-lived: workspace choice is sticky across sessions.
    maxAge: 60 * 60 * 24 * 365,
  });

  logUsage({
    event: "workspace.set_active",
    surface: "action",
    user_id: user.id,
    workspace_id: workspaceId,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  // Refresh every server-rendered surface that reads the active workspace.
  revalidatePath("/", "layout");

  return { ok: true };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  await supabase.auth.signOut();

  // Clear the workspace pref so the next user on this device doesn't inherit
  // someone else's choice.
  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_WORKSPACE_COOKIE);

  logUsage({
    event: "auth.sign_out",
    surface: "auth",
    user_id: user?.id ?? null,
    status: "ok",
  });

  redirect("/login");
}

// ---------- workspace lifecycle --------------------------------------------

const WORKSPACE_NAME_MAX = 60;
const SLUG_BASE_MAX = 35; // leaves room for a `-XXXX` suffix within the 40-char cap

// Derive a slug from a free-form workspace name. The DB constraint
// (`workspaces_slug_format`) requires `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, so
// we lowercase, collapse non-alphanumerics into single dashes, trim leading/
// trailing dashes, and clamp the length. Returns the empty string for names
// that produce no usable characters (e.g. all punctuation) — the caller is
// expected to handle that as a fallback.
function slugifyWorkspaceName(name: string): string {
  const trimmed = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining marks (accents, diacritics)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return trimmed.slice(0, SLUG_BASE_MAX).replace(/-+$/g, "");
}

// 4-char [a-z0-9] suffix appended when the base slug already exists.
function randomSlugSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// Resolve a unique slug for a new workspace. We first try the base derived
// from the name; if it's taken, we append a random 4-char suffix and retry
// a small number of times. The DB UNIQUE constraint on (slug) is the source
// of truth — if we lose a race the INSERT will fail and the caller retries.
async function resolveUniqueWorkspaceSlug(
  admin: ReturnType<typeof createAdminClient>,
  name: string,
): Promise<string> {
  const base = slugifyWorkspaceName(name) || "workspace";
  // The constraint requires length 3-40 — pad short bases.
  const padded = base.length >= 3 ? base : `${base}-ws`.slice(0, SLUG_BASE_MAX);

  const { data: existing } = await admin
    .from("workspaces")
    .select("slug")
    .eq("slug", padded)
    .maybeSingle();
  if (!existing) return padded;

  for (let i = 0; i < 6; i++) {
    const candidate = `${padded}-${randomSlugSuffix()}`.slice(0, 40);
    const { data: clash } = await admin
      .from("workspaces")
      .select("slug")
      .eq("slug", candidate)
      .maybeSingle();
    if (!clash) return candidate;
  }
  // Last-resort fallback — vanishingly unlikely but keeps types honest.
  return `${padded}-${randomSlugSuffix()}-${randomSlugSuffix()}`.slice(0, 40);
}

// Creates a new workspace + the caller's owner membership in one logical
// block. RLS on public.workspaces has NO insert policy for authenticated
// users (intentional — see 0000_workspace_foundation.sql), so this action
// uses the service-role admin client. If the membership insert fails we
// roll back the workspace to avoid orphaned tenancy rows.
//
// On success, switches the user to the new workspace (cookie) and
// revalidates the layout so the topbar refreshes.
export async function createWorkspaceAction(
  formData: FormData,
): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const started = Date.now();
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "not_authenticated" };
  }

  const rawName = String(formData.get("name") ?? "");
  const name = rawName.trim();
  if (!name) {
    return { ok: false, error: "name_required" };
  }
  if (name.length > WORKSPACE_NAME_MAX) {
    return { ok: false, error: "name_too_long" };
  }

  const admin = createAdminClient();
  const slug = await resolveUniqueWorkspaceSlug(admin, name);

  const { data: workspace, error: insertErr } = await admin
    .from("workspaces")
    .insert({ name, slug })
    .select("id")
    .single();
  if (insertErr || !workspace) {
    logUsage({
      event: "workspace.create",
      surface: "action",
      user_id: user.id,
      status: "error",
      duration_ms: Date.now() - started,
      error: insertErr,
      error_code: insertErr?.code ?? "workspace_insert_failed",
    });
    return {
      ok: false,
      error: insertErr?.message ?? "Could not create workspace.",
    };
  }

  const { error: memErr } = await admin.from("workspace_memberships").insert({
    workspace_id: workspace.id,
    user_id: user.id,
    role: "owner",
  });
  if (memErr) {
    // Roll back so we don't leave an orphan workspace nobody can reach.
    await admin.from("workspaces").delete().eq("id", workspace.id);
    logUsage({
      event: "workspace.create",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "error",
      duration_ms: Date.now() - started,
      error: memErr,
      error_code: memErr.code ?? "membership_insert_failed",
    });
    return {
      ok: false,
      error: memErr.message ?? "Could not add you to the new workspace.",
    };
  }

  // Switch the user to the freshly created workspace so subsequent server-
  // rendered pages resolve it as active. Long-lived to match the
  // setActiveWorkspaceAction cookie shape.
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspace.id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  logUsage({
    event: "workspace.create",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  // Refresh every server-rendered surface that reads the active workspace.
  revalidatePath("/", "layout");

  return { ok: true, workspaceId: workspace.id };
}

// Rename the active workspace. Uses the user-context client; RLS policy
// `admins and owners update workspace` gates who can rename.
export async function renameWorkspaceAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const { user, workspace, role } = await getActiveWorkspace(
    "/settings/workspace",
  );
  if (role !== "owner" && role !== "admin") {
    logUsage({
      event: "workspace.rename",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
    });
    return { ok: false, error: "not_authorized" };
  }

  const rawName = String(formData.get("name") ?? "");
  const name = rawName.trim();
  if (!name) {
    return { ok: false, error: "name_required" };
  }
  if (name.length > WORKSPACE_NAME_MAX) {
    return { ok: false, error: "name_too_long" };
  }
  if (name === workspace.name) {
    // No-op — succeed silently so the UI can close the form.
    return { ok: true };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ name })
    .eq("id", workspace.id);
  if (error) {
    logUsage({
      event: "workspace.rename",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_failed",
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "workspace.rename",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath("/", "layout");
  return { ok: true };
}

// Toggle the active workspace's "members may approve their own proposals"
// setting. Admin/owner only (re-checked here and enforced by the
// `admins and owners update workspace` RLS policy). When on, the
// canvas_apply_edit / canvas_reject_edit RPCs let any member self-resolve
// their own proposal; when off, only admins/owners can.
export async function setSelfApprovalAction(
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const { user, workspace, role } = await getActiveWorkspace(
    "/settings/workspace",
  );
  if (role !== "owner" && role !== "admin") {
    logUsage({
      event: "workspace.set_self_approval",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
    });
    return { ok: false, error: "not_authorized" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .update({ canvas_allow_self_approval: enabled })
    .eq("id", workspace.id);
  if (error) {
    logUsage({
      event: "workspace.set_self_approval",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "update_failed",
    });
    return { ok: false, error: error.message };
  }

  logUsage({
    event: "workspace.set_self_approval",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
    props: { enabled },
  });

  revalidatePath("/", "layout");
  return { ok: true };
}

// Delete the active workspace. Owner-only by RLS (`owners delete workspace`).
// On success the active-workspace cookie is cleared and the caller is
// redirected to /no-workspace. Other rows owned by the workspace cascade
// via ON DELETE CASCADE.
export async function deleteWorkspaceAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const started = Date.now();
  const { user, workspace, role } = await getActiveWorkspace(
    "/settings/workspace",
  );
  if (role !== "owner") {
    logUsage({
      event: "workspace.delete",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "denied",
      duration_ms: Date.now() - started,
      error_code: "not_authorized",
    });
    return { ok: false, error: "not_authorized" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("workspaces")
    .delete()
    .eq("id", workspace.id);
  if (error) {
    logUsage({
      event: "workspace.delete",
      surface: "action",
      user_id: user.id,
      workspace_id: workspace.id,
      status: "error",
      duration_ms: Date.now() - started,
      error,
      error_code: error.code ?? "delete_failed",
    });
    return { ok: false, error: error.message };
  }

  // Clear the active-workspace cookie so getActiveWorkspace falls back to the
  // user's next membership (or /no-workspace if there are none left).
  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_WORKSPACE_COOKIE);

  logUsage({
    event: "workspace.delete",
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath("/", "layout");
  return { ok: true };
}

const DISPLAY_NAME_MAX = 60;

// Update the caller's display name. The name lives in two places that must
// stay in sync: auth.users.user_metadata (what the Topbar reads off the
// session) and public.users.name (what members lists, comments, and activity
// feeds join against). The public.users write is allowed by the "users update
// own profile" RLS policy; new signups mirror metadata via the
// on_auth_user_created trigger, so this action is the only other writer.
export async function updateDisplayNameAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "name_required" };
  }
  if (name.length > DISPLAY_NAME_MAX) {
    return { ok: false, error: "name_too_long" };
  }

  const { error: authError } = await supabase.auth.updateUser({
    data: { name },
  });
  if (authError) {
    logUsage({
      event: "profile.rename",
      surface: "action",
      user_id: user.id,
      status: "error",
      duration_ms: Date.now() - started,
      error: authError,
      error_code: authError.code ?? "auth_update_failed",
    });
    return { ok: false, error: authError.message };
  }

  const { error: profileError } = await supabase
    .from("users")
    .update({ name })
    .eq("id", user.id);
  if (profileError) {
    logUsage({
      event: "profile.rename",
      surface: "action",
      user_id: user.id,
      status: "error",
      duration_ms: Date.now() - started,
      error: profileError,
      error_code: profileError.code ?? "profile_update_failed",
    });
    return { ok: false, error: profileError.message };
  }

  logUsage({
    event: "profile.rename",
    surface: "action",
    user_id: user.id,
    status: "ok",
    duration_ms: Date.now() - started,
  });

  revalidatePath("/", "layout");
  return { ok: true };
}
