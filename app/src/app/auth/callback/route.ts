import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAfterSignInRedirect } from "@/lib/auth/redirect";
import { logUsage } from "@/lib/usage/log";
import { appOrigin } from "@/lib/app-url";

// OAuth callback (Google). Supabase Auth redirects here with ?code=...
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Build redirects off the canonical public origin, not url.origin: self-hosted
  // Next derives request.url's host as localhost:PORT (see lib/app-url).
  const origin = appOrigin(request);

  // `next` from URL is preserved by magic-link flow; OAuth flow drops it (Supabase
  // strips query params from redirectTo), so we fall back to the auth_next cookie
  // that GoogleButton sets just before initiating sign-in.
  const cookieStore = await cookies();
  const cookieNext = cookieStore.get("auth_next")?.value;
  const next =
    url.searchParams.get("next") ??
    (cookieNext ? decodeURIComponent(cookieNext) : null);

  if (!code) {
    logUsage({
      event: "auth.login",
      surface: "auth",
      status: "error",
      error_code: "missing_code",
      props: { provider: "oauth" },
    });
    return NextResponse.redirect(new URL("/login?error=missing_code", origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    logUsage({
      event: "auth.login",
      surface: "auth",
      status: "error",
      error_code: "exchange_failed",
      props: { provider: "oauth" },
    });
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, origin),
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  logUsage({
    event: "auth.login",
    surface: "auth",
    user_id: user?.id ?? null,
    status: "ok",
    props: { provider: "oauth" },
  });

  const destination = await resolveAfterSignInRedirect(supabase, next);

  const response = NextResponse.redirect(new URL(destination, origin));
  if (cookieNext) response.cookies.delete("auth_next");
  return response;
}
