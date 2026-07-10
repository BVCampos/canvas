import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { resolveAfterSignInRedirect } from "@/lib/auth/redirect";
import { logUsage } from "@/lib/usage/log";
import { appOrigin } from "@/lib/app-url";

// Magic link / email OTP confirmation. Supabase Auth redirects here with
// ?token_hash=...&type=...
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next");
  // Canonical public origin, not url.origin (localhost on self-host; see app-url).
  const origin = appOrigin(request);

  if (!token_hash || !type) {
    logUsage({
      event: "auth.confirm",
      surface: "auth",
      status: "error",
      error_code: "missing_token",
      props: { type: type ?? null },
    });
    return NextResponse.redirect(
      new URL("/login?error=missing_token", origin),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash });
  if (error) {
    logUsage({
      event: "auth.confirm",
      surface: "auth",
      status: "error",
      error,
      error_code: "verify_failed",
      props: { type },
    });
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, origin),
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  logUsage({
    event: "auth.confirm",
    surface: "auth",
    user_id: user?.id ?? null,
    status: "ok",
    props: { type },
  });

  const destination = await resolveAfterSignInRedirect(supabase, next);
  return NextResponse.redirect(new URL(destination, origin));
}
