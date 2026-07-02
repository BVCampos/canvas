import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseUrl, supabasePublishableKey } from "./env";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // setAll called from a Server Component; ignore — middleware will refresh.
        }
      },
    },
  });
}
