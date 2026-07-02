import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Cookie that remembers which workspace the user last selected in the
// switcher. Read by getActiveWorkspace, written by setActiveWorkspaceAction.
export const ACTIVE_WORKSPACE_COOKIE = "canvas_active_workspace";

export type WorkspaceRole = "owner" | "admin" | "member" | "guest";

const WORKSPACE_ROLES: readonly WorkspaceRole[] = [
  "owner",
  "admin",
  "member",
  "guest",
];

// Narrow an unknown value (typically a Supabase query result) to a
// WorkspaceRole. Returns null for any string we don't recognise — caller
// should treat null as "no role" rather than escalating to a default.
export function parseWorkspaceRole(value: unknown): WorkspaceRole | null {
  return typeof value === "string" &&
    (WORKSPACE_ROLES as readonly string[]).includes(value)
    ? (value as WorkspaceRole)
    : null;
}

export type WorkspaceMembership = {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
};

// Lists every workspace the user belongs to, ordered by joined_at (oldest
// first). Used by the topbar switcher and as the source of truth for picking
// the active workspace.
async function listWorkspaceMemberships(
  userId: string,
): Promise<WorkspaceMembership[]> {
  const supabase = await createClient();

  const { data: memberships } = await supabase
    .from("workspace_memberships")
    .select("role, workspace_id, joined_at")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true });

  if (!memberships || memberships.length === 0) return [];

  const ids = memberships.map((m) => m.workspace_id as string);
  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, slug, name")
    .in("id", ids);

  if (!workspaces) return [];

  const byId = new Map(
    (workspaces as { id: string; slug: string; name: string }[]).map(
      (w) => [w.id, w] as const,
    ),
  );

  return memberships
    .map((m) => {
      const w = byId.get(m.workspace_id as string);
      if (!w) return null;
      return {
        id: w.id,
        slug: w.slug,
        name: w.name,
        role: m.role as WorkspaceRole,
      };
    })
    .filter((m): m is WorkspaceMembership => m !== null);
}

// Resolves the active workspace + asserts the signed-in user is a member.
//
// Active workspace selection:
//   1. If the canvas_active_workspace cookie names a workspace the user is
//      still a member of, use that.
//   2. Otherwise fall back to the oldest membership.
//
// Behavior:
//   - No session → redirect to /login?next=<current path>
//   - Session but zero memberships → redirect to /no-workspace
export const getActiveWorkspace = cache(async (nextPath?: string) => {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`);
  }

  const memberships = await listWorkspaceMemberships(user.id);
  if (memberships.length === 0) {
    redirect("/no-workspace");
  }

  const cookieStore = await cookies();
  const preferredId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const active =
    memberships.find((m) => m.id === preferredId) ?? memberships[0];

  return {
    user,
    workspace: { id: active.id, slug: active.slug, name: active.name },
    workspaces: memberships,
    role: active.role,
  };
});
