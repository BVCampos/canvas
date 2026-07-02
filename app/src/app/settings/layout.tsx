import { getActiveWorkspace } from "@/lib/auth/workspace";
import { Topbar } from "@/components/topbar";
import { SettingsNav } from "./settings-nav";

// Shared chrome for every /settings/* page. Resolves the workspace once
// (cached() inside getActiveWorkspace) so per-page components can call it
// again without an extra DB round-trip.
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, workspace, workspaces, role } = await getActiveWorkspace("/settings");

  return (
    <div className="min-h-dvh">
      <Topbar user={user} workspace={workspace} workspaces={workspaces} role={role} />
      {/* Full-width shell: px-4 on mobile keeps the gutter inside a 360px
          viewport, wider gutters return at sm+/lg+. Below lg the nav is a tab
          row above the content (original layout); at lg+ it becomes a left
          rail and the content takes the remaining width. */}
      <main className="w-full px-4 sm:px-6 lg:px-8 py-8">
        <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-start lg:gap-10">
          <SettingsNav role={role} />
          <div className="mt-6 space-y-6 lg:mt-0">{children}</div>
        </div>
      </main>
    </div>
  );
}
