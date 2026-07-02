import { notFound } from "next/navigation";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { appOrigin } from "@/lib/app-url";
import { PublicLinksList, type PublicLink } from "./public-links-list";

// /settings/sharing — owner/admin only. "Public links" audit panel.
//
// Any editor (or a guest with edit access) can mint a world-readable public
// link on a deck or project from its Share dialog. There was no workspace-level
// view of WHAT is currently exposed to the open internet, so an admin couldn't
// answer "list every deck/project with a live public link" without raw SQL, and
// a forgotten link stayed live indefinitely. This page enumerates them and lets
// an admin revoke any one with a click. Reads go through the admin client (the
// page's role gate is the authority) so the list is the true workspace-wide set,
// not the RLS-filtered slice the actor happens to have.

export default async function SharingSettingsPage() {
  const { workspace, role } = await getActiveWorkspace("/settings/sharing");
  if (role !== "owner" && role !== "admin") {
    notFound();
  }

  const admin = createAdminClient();
  const origin = appOrigin();

  const [decksRes, projectsRes] = await Promise.all([
    admin
      .from("canvas_deck")
      .select("id, title, public_share_token, visibility, updated_at")
      .eq("workspace_id", workspace.id)
      .not("public_share_token", "is", null)
      .order("updated_at", { ascending: false }),
    admin
      .from("canvas_project")
      .select("id, name, public_share_token, visibility")
      .eq("workspace_id", workspace.id)
      .not("public_share_token", "is", null)
      .order("name", { ascending: true }),
  ]);

  const links: PublicLink[] = [
    ...(decksRes.data ?? []).map((d) => ({
      kind: "deck" as const,
      id: d.id as string,
      name: (d.title as string) || "Untitled deck",
      visibility: (d.visibility as string | null) ?? null,
      url: `${origin}/p/${d.public_share_token as string}`,
    })),
    ...(projectsRes.data ?? []).map((p) => ({
      kind: "project" as const,
      id: p.id as string,
      name: (p.name as string) || "Untitled project",
      visibility: (p.visibility as string | null) ?? null,
      url: `${origin}/p/project/${p.public_share_token as string}`,
    })),
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Public links</h1>
        <p className="text-sm text-muted-foreground">
          Everything in this workspace currently reachable by anyone with the link.
          Revoking turns the link off immediately; a new one can always be minted
          again from the deck or project Share dialog.
        </p>
      </div>
      <PublicLinksList links={links} />
    </div>
  );
}
