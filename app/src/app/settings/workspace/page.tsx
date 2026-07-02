import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createClient } from "@/lib/supabase/server";
import { WorkspaceForm } from "./workspace-form";

// /settings/workspace — visible to every member; rename + delete affordances
// only show for admin/owner and owner respectively. Settings-nav puts this
// tab first so brand-new owners land on workspace identity before tooling
// (Members) or integrations (MCP).

export default async function WorkspaceSettingsPage() {
  const { workspace, role } = await getActiveWorkspace("/settings/workspace");

  // getActiveWorkspace already enforces "is a member" (would have redirected
  // to /no-workspace if not). Guard against future drift by re-asserting.
  const supabase = await createClient();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, slug, name, canvas_allow_self_approval")
    .eq("id", workspace.id)
    .maybeSingle();
  if (!ws) redirect("/canvases");

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Identity and lifecycle for{" "}
          <strong className="font-medium text-foreground">{ws.name}</strong>.
        </p>
      </div>

      <WorkspaceForm
        name={ws.name}
        slug={ws.slug}
        role={role}
        allowSelfApproval={ws.canvas_allow_self_approval === true}
      />
    </>
  );
}
