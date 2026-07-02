import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseUrl, supabasePublishableKey } from "./env";
import { protectedPageNextPath } from "@/lib/auth/redirect";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: getUser() must be called to refresh the session cookie.
  // Do not put any code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Optimistic page guard: preserve the exact destination in `next` before a
  // parent layout can collapse it to a generic section path. Pages still run
  // their own getUser + authorization checks; Proxy is not the security gate.
  const nextPath = protectedPageNextPath(
    request.nextUrl.pathname,
    request.nextUrl.search,
  );
  if (!user && nextPath) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", nextPath);
    const redirectResponse = NextResponse.redirect(loginUrl);
    // Preserve any Supabase cookie refresh/clear performed above on the redirect.
    for (const cookie of response.cookies.getAll()) {
      redirectResponse.cookies.set(cookie);
    }
    return redirectResponse;
  }

  return response;
}
