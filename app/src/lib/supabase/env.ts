// Next.js / Webpack inlines NEXT_PUBLIC_* env vars only on LITERAL access
// (process.env.NEXT_PUBLIC_FOO). A helper using a dynamic key falls back to
// undefined in the browser bundle, so we access each var directly.

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const supabaseUrl = required(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  "NEXT_PUBLIC_SUPABASE_URL",
);

export const supabasePublishableKey = required(
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
);

// Server-only secret. Accessing this from a Client Component will throw because
// SUPABASE_SECRET_KEY is not exposed to the browser.
export function getSupabaseSecretKey(): string {
  return required(process.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
}
