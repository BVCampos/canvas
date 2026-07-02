import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createClient } from "@/lib/supabase/server";
import { ThemeToggle } from "@/components/theme-toggle";
import { displayName } from "@/lib/utils";
import { ProfileForm } from "./profile-form";

// /settings/account — the caller's own settings: profile identity + appearance.
// Everything here is user-scoped (visible to every role, including guests);
// workspace-scoped settings live on the sibling tabs.

export default async function AccountSettingsPage() {
  const { user } = await getActiveWorkspace("/settings/account");

  // Prefer the mirrored public.users row (what teammates see in members lists
  // and comments); fall back to auth metadata for accounts created before the
  // mirror trigger ran.
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("name")
    .eq("id", user.id)
    .maybeSingle();

  const email = user.email ?? "";
  const name = displayName({
    email,
    name:
      (profile?.name as string | null | undefined) ??
      (user.user_metadata?.name as string | null | undefined) ??
      (user.user_metadata?.full_name as string | null | undefined) ??
      null,
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your profile and how Canvas looks for you. These apply everywhere you
          sign in, across all your workspaces.
        </p>
      </div>

      <section className="rounded-[12px] border border-border bg-card p-6 space-y-4">
        <div className="eyebrow">Profile</div>
        <ProfileForm name={name} email={email} />
      </section>

      <section className="rounded-[12px] border border-border bg-card p-6 space-y-3">
        <div className="eyebrow">Appearance</div>
        <p className="text-xs text-muted-foreground">
          Stored on this device — pick per browser.
        </p>
        {/* Reuse the user-menu control so the two surfaces can never drift;
            cap the width so the segmented buttons don't stretch across a
            full-width card. */}
        <div className="max-w-xs -mx-2">
          <ThemeToggle />
        </div>
      </section>
    </>
  );
}
