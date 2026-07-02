import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { supabaseUrl, getSupabaseSecretKey } from "./env";

// Service-role client. Bypasses RLS — use only on the server for:
// - HTML parser uploading deck assets to Storage on behalf of the importer
// - MCP token issuance / revocation
// - Isolation tests
// Never import from a Client Component.
export function createAdminClient() {
  return createSupabaseJsClient(supabaseUrl, getSupabaseSecretKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
