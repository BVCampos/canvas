import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signOutAction } from "@/lib/auth/actions";
import { acceptInviteAndRedirect } from "./actions";

// /invite/{token} — landing page from the invite email (or a copy-paste
// link from the admin). The page deliberately does NOT auto-accept on
// load; the explicit "Join Workspace" button is the user's consent step.

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token: rawToken } = await params;
  const token = decodeURIComponent(rawToken);
  const { error: errorMessage } = await searchParams;

  // Look up the invite with the admin client — the visitor either isn't
  // authenticated, or even if they are, they're not yet a member of this
  // workspace so RLS would hide the row.
  const admin = createAdminClient();
  const { data: invite } = await admin
    .from("workspace_invites")
    .select(
      "id, email, role, expires_at, accepted_at, deck_id, deck_role, project_id, project_role, workspace:workspaces(slug, name), deck:canvas_deck(id, title), project:canvas_project(id, name)",
    )
    .eq("token", token)
    .maybeSingle();

  // The Supabase relation returns `workspace`/`deck`/`project` as arrays in the
  // typegen but there's at most one — normalize so the rest of this component
  // is happy.
  const workspace = Array.isArray(invite?.workspace)
    ? invite?.workspace[0]
    : invite?.workspace;
  const deck = Array.isArray(invite?.deck) ? invite?.deck[0] : invite?.deck;
  const project = Array.isArray(invite?.project)
    ? invite?.project[0]
    : invite?.project;
  // A deck-scoped guest invite (an outside reviewer): name the deck and the
  // narrow scope rather than the generic "join the workspace" framing.
  const isDeckScoped = Boolean(invite?.deck_id && invite?.deck_role);
  // A project-scoped guest invite: same framing, but the scope is a whole
  // project (all its decks) rather than a single deck.
  const isProjectScoped = Boolean(invite?.project_id && invite?.project_role);
  const deckRoleLabel =
    invite?.deck_role === "editor"
      ? "an editor — view, comment, and edit slides"
      : "a reviewer — view and comment";
  const projectRoleLabel =
    invite?.project_role === "editor"
      ? "an editor — view, comment, and edit every deck"
      : "a reviewer — view and comment on every deck";

  if (!invite || !workspace) {
    return (
      <InviteShell title="Invite not found">
        This invite link is invalid or has been revoked.
      </InviteShell>
    );
  }

  if (invite.accepted_at) {
    // If the signed-in viewer IS the invitee, don't dead-end them on "already
    // used" — they've already got the grant, so send them where the invite
    // would have: the deck (guest) or the deck list (member).
    const supabaseForAccepted = await createClient();
    const {
      data: { user: acceptedUser },
    } = await supabaseForAccepted.auth.getUser();
    if (
      acceptedUser?.email &&
      acceptedUser.email.trim().toLowerCase() ===
        invite.email.trim().toLowerCase()
    ) {
      redirect(invite.deck_id ? `/canvases/${invite.deck_id}` : "/canvases");
    }
    return (
      <InviteShell title="Already accepted">
        This invite has already been used. If that was you,{" "}
        <Link href="/login" className="text-brand underline-offset-4 hover:underline">
          sign in
        </Link>{" "}
        to reach your{" "}
        {isDeckScoped ? "deck" : isProjectScoped ? "project" : "workspace"}.
      </InviteShell>
    );
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <InviteShell title="Invite expired">
        Ask the workspace owner to send a fresh invite to {invite.email}.
      </InviteShell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Not signed in → send to /login with this page as the next destination.
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const signedInEmail = user.email ?? "";
  const emailMatches =
    signedInEmail.trim().toLowerCase() === invite.email.trim().toLowerCase();

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-6">
        <Logo />
        <div className="text-center">
          {isDeckScoped ? (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                You&rsquo;ve been invited to review
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                {deck?.title ?? "a deck"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                as{" "}
                <span className="text-foreground font-medium">
                  {deckRoleLabel}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                You&rsquo;ll only see this deck — nothing else in{" "}
                {workspace.name}.
              </p>
            </>
          ) : isProjectScoped ? (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                You&rsquo;ve been invited to review
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                {project?.name ?? "a project"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                as{" "}
                <span className="text-foreground font-medium">
                  {projectRoleLabel}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                You&rsquo;ll only see this project and its decks — nothing else
                in {workspace.name}.
              </p>
            </>
          ) : (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                You&rsquo;ve been invited
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
                Join {workspace.name} on Canvas
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                as{" "}
                <span className="text-foreground font-medium">
                  {invite.role}
                </span>{" "}
                ·{" "}
                {invite.role === "owner"
                  ? "full control of the workspace and its decks"
                  : invite.role === "admin"
                    ? "manage members and view + edit every deck"
                    : "view and edit every workspace-visible deck"}
              </p>
            </>
          )}
        </div>
      </div>

      {emailMatches ? (
        <form action={acceptInviteAndRedirect.bind(null, token)} className="space-y-3">
          <Button type="submit" className="w-full h-10">
            {isDeckScoped
              ? "Open deck"
              : isProjectScoped
                ? "Open project"
                : "Join Workspace"}
          </Button>
          {errorMessage && (
            <p className="text-xs text-destructive text-center" role="alert">
              {errorMessage}
            </p>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Signing in as {signedInEmail}
          </p>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="rounded-[8px] border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <div className="font-medium text-destructive">Wrong account</div>
            <p className="mt-1 text-muted-foreground">
              This invite is for{" "}
              <span className="text-foreground">{invite.email}</span> but
              you&rsquo;re signed in as{" "}
              <span className="text-foreground">{signedInEmail}</span>.
            </p>
          </div>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" className="w-full">
              Sign out and try again
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

function InviteShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4">
        <Logo />
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
      </div>
      <div className="rounded-[8px] border bg-card p-4 text-sm text-muted-foreground text-center">
        {children}
      </div>
      <Link
        href="/login"
        className="block text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        Back to sign in
      </Link>
    </div>
  );
}
