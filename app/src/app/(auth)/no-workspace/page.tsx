import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signOutAction } from "@/lib/auth/actions";
import { CreateWorkspaceForm } from "./create-workspace-form";

// /no-workspace — landing for a signed-in user with zero workspace
// memberships. Canvas is now standalone (ADR-0004), so the right primary
// action is "create your workspace", not "ask for an invite". The escape
// hatches for users who landed here by mistake stay:
//
//  1. Sign out + try a different email (most common: signed in with the
//     wrong Google account for a workspace they already belong to).
//
// (Migration 0013 still auto-joins @21xventures.com emails to the 21x
// Ventures seed on first sign-in, but we no longer advertise that here —
// the footnote read as internal jargon to every external user.)

export default async function NoWorkspacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email ?? "—";

  // Was this person ever invited as an outside reviewer (a deck-scoped guest)?
  // If so, landing here almost always means their deck access ended — nudging
  // them to "create a workspace" is the wrong thing to say. Invite emails are
  // stored lower-cased by both invite paths. Fails open (no banner) on error.
  let wasReviewer = false;
  if (user?.email) {
    try {
      const admin = createAdminClient();
      const { data: priorGuest } = await admin
        .from("workspace_invites")
        .select("id")
        .eq("email", user.email.trim().toLowerCase())
        .not("deck_id", "is", null)
        .limit(1)
        .maybeSingle();
      wasReviewer = Boolean(priorGuest);
    } catch {
      wasReviewer = false;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4">
        <Logo />
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Create your workspace
          </h1>
          <p className="text-sm text-muted-foreground">
            A workspace is where your decks, comments, and agent proposals
            live. You can invite teammates after.
          </p>
        </div>
      </div>

      {wasReviewer && (
        <div className="rounded-[12px] border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          Were you reviewing a deck here? Your access may have ended. Ask the
          person who shared it to send you a fresh link — you don&rsquo;t need
          your own workspace for that.
        </div>
      )}

      <div className="rounded-[12px] border border-border bg-card p-5">
        <CreateWorkspaceForm />
      </div>

      <div className="space-y-3">
        <p className="text-center text-xs text-muted-foreground">
          Wrong account? Sign out and try a different email.
        </p>
        <form action={signOutAction}>
          <Button type="submit" variant="outline" className="w-full">
            Sign out ({email})
          </Button>
        </form>
      </div>
    </div>
  );
}
