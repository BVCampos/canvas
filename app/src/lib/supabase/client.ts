import { createBrowserClient } from "@supabase/ssr";
import { supabaseUrl, supabasePublishableKey } from "./env";

export function createClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
