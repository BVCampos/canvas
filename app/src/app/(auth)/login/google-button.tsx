"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function GoogleButton({ next }: { next: string | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    const supabase = createClient();

    // Supabase strips query params from redirectTo during the OAuth handshake,
    // so we stash `next` in a short-lived cookie that /auth/callback reads back.
    if (next) {
      document.cookie = `auth_next=${encodeURIComponent(next)}; Path=/; Max-Age=600; SameSite=Lax`;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: new URL("/auth/callback", window.location.origin).toString(),
      },
    });
    if (error) {
      setError(error.message);
      setPending(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        className="w-full h-10"
        onClick={handleClick}
        disabled={pending}
      >
        <GoogleGlyph />
        {pending ? "Redirecting…" : "Continue with Google"}
      </Button>
      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h6.45a5.51 5.51 0 0 1-2.4 3.62v3h3.87c2.27-2.1 3.57-5.18 3.57-8.65z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.12A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29A7.21 7.21 0 0 1 4.89 12c0-.79.14-1.57.38-2.29V6.59H1.27a12 12 0 0 0 0 10.82l4-3.12z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.59l4 3.12C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}
