import { getActiveWorkspace } from "@/lib/auth/workspace";
import { Topbar } from "@/components/topbar";

// Shell for /releases. Same auth + topbar chrome as the settings pages; the
// page itself is static content, so this layout is the only server work.
export default async function ReleasesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, workspace, workspaces, role } = await getActiveWorkspace("/releases");

  return (
    <div className="min-h-dvh">
      <Topbar user={user} workspace={workspace} workspaces={workspaces} role={role} />
      {/* Full-width like /settings; the page lays its release items out in a
          responsive grid so wide viewports get columns, not stretched cards. */}
      <main className="w-full px-4 sm:px-6 lg:px-8 py-8">{children}</main>
    </div>
  );
}
