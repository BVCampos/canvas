"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/auth/redirect";

export function MagicLinkForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sent"; email: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setStatus({ kind: "idle" });

    const supabase = createClient();
    // signInWithOtp uses PKCE → /auth/callback (exchangeCodeForSession);
    // admin-generated links use token_hash → /auth/confirm (verifyOtp).
    const emailRedirectTo = new URL("/auth/callback", window.location.origin);
    // Sanitize before baking into the emailed link (defense-in-depth — the
    // callback also re-checks).
    const safeNext = safeNextPath(next);
    if (safeNext) emailRedirectTo.searchParams.set("next", safeNext);

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: emailRedirectTo.toString() },
    });

    if (error) {
      setStatus({ kind: "error", message: error.message });
    } else {
      setStatus({ kind: "sent", email });
    }
    setPending(false);
  }

  if (status.kind === "sent") {
    return (
      <div className="rounded-[8px] border border-border bg-card p-4 text-sm">
        <div className="font-medium text-foreground">Check your inbox</div>
        <p className="mt-1 text-muted-foreground">
          We sent a sign-in link to{" "}
          <span className="text-foreground tabular">{status.email}</span>. The link
          expires in 1 hour.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <Input
        type="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        disabled={pending}
      />
      <Button type="submit" className="w-full h-10" disabled={pending || !email}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
      {status.kind === "error" && (
        <p className="text-xs text-destructive" role="alert">
          {status.message}
        </p>
      )}
    </form>
  );
}
