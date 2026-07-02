"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { logUsage } from "@/lib/usage/log";

// Server actions for the admin "Public links" panel (/settings/sharing).
//
// These revoke a deck's or project's public share token from a WORKSPACE-ADMIN
// vantage point — the override the per-deck/per-project share dialogs don't
// give. A link minted by any editor (or a guest-turned-editor) otherwise stays
// live forever, invisible to admins. We gate strictly on owner/admin of the
// ACTIVE workspace and re-verify the target belongs to that workspace before
// nulling the token (so an admin of workspace A can never revoke a link in
// workspace B by id). The admin client is used deliberately: admin authority
// here is the role check, not per-row RLS.

export type RevokeResult = { ok: true } | { ok: false; error: string };

async function revokePublicLink(
  table: "canvas_deck" | "canvas_project",
  id: string,
  event: "deck.public_share" | "project.public_share",
): Promise<RevokeResult> {
  const { user, workspace, role } = await getActiveWorkspace("/settings/sharing");
  if (role !== "owner" && role !== "admin") {
    return { ok: false, error: "Only workspace admins can revoke public links." };
  }

  const admin = createAdminClient();

  // Scope the write to (id AND active workspace): an admin can only revoke links
  // on targets in the workspace they administer. A non-null token requirement
  // makes the update a no-op for an already-revoked link (idempotent revoke).
  const { error } = await admin
    .from(table)
    .update({ public_share_token: null })
    .eq("id", id)
    .eq("workspace_id", workspace.id)
    .not("public_share_token", "is", null);

  if (error) {
    console.error(`[sharing:revoke:${table}]`, error);
    return { ok: false, error: error.message };
  }

  logUsage({
    event,
    surface: "action",
    user_id: user.id,
    workspace_id: workspace.id,
    status: "ok",
    props: { id, action: "admin_revoke", enabled: false },
  });

  revalidatePath("/settings/sharing");
  return { ok: true };
}

export async function revokeDeckPublicLink(deckId: string): Promise<RevokeResult> {
  return revokePublicLink("canvas_deck", deckId, "deck.public_share");
}

export async function revokeProjectPublicLink(projectId: string): Promise<RevokeResult> {
  return revokePublicLink("canvas_project", projectId, "project.public_share");
}
