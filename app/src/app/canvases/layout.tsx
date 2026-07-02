import { getActiveWorkspace } from "@/lib/auth/workspace";
import { Topbar } from "@/components/topbar";
import { PresenceProvider } from "./presence-provider";

// Layout wrapper for every /canvases/* route. Resolves auth + active workspace
// once, then renders the topbar. Page-level wrappers (list, editor, history)
// pick their own container width — the deck editor wants full-width, the list
// wants `max-w-6xl`.
export default async function CanvasesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, workspace, workspaces, role } = await getActiveWorkspace("/canvases");

  return (
    // min-h-dvh (not min-h-screen): mobile Safari's collapsing URL bar makes
    // 100vh taller than the visible viewport, which would let the page under-
    // scroll past the topbar on short pages. Matches the settings/auth shells.
    //
    // PresenceProvider wraps BOTH the topbar and the deck route so per-deck
    // presence (tracked from inside the deck route) reaches the topbar's
    // PresenceStack through context — see presence-provider.tsx for the why.
    <PresenceProvider>
      <div className="min-h-dvh">
        <Topbar user={user} workspace={workspace} workspaces={workspaces} role={role} />
        {children}
      </div>
    </PresenceProvider>
  );
}
