import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/lib/supabase/server";
import { resolveAfterSignInRedirect, safeNextPath } from "@/lib/auth/redirect";
import { GoogleButton } from "./google-button";
import { MagicLinkForm } from "./magic-link-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Sanitize once at the boundary; pass the safe value to every consumer.
  const safeNext = safeNextPath(next ?? null);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect(await resolveAfterSignInRedirect(supabase, safeNext));
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-6">
        <Logo />
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Sign in to Canvas
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Multiplayer HTML decks, built with any agent.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <GoogleButton next={safeNext} />

        <div className="relative">
          <Separator />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            or
          </span>
        </div>

        <MagicLinkForm next={safeNext} />
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Need an invite? Ask the owner of your Workspace.
      </p>
    </div>
  );
}
