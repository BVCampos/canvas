import "server-only";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Shared plumbing for sending a Canvas invite link by email. Used by both the
// workspace member invite (lib/actions/members.ts) and the deck-scoped guest
// invite (canvases/[id]/actions.ts) so there's a single copy of the
// base-URL resolution and the inviteUserByEmail → magic-link fallback.

// Resolve the absolute base URL of the running Canvas instance. Prefer the
// configured public origin (NEXT_PUBLIC_APP_URL — localhost in dev, the real
// host in prod): self-hosted Next standalone can't be trusted to reflect the
// public host in request-derived URLs (the box sees Host: localhost:3001), so a
// header-first resolution mints localhost invite links. See lib/app-url for the
// same reasoning behind the redirect-route fix. Falls back to the request
// headers only when the env var is unset.
export async function resolveAppBaseUrl(): Promise<string> {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  const reqHeaders = await headers();
  const host = reqHeaders.get("host");
  if (host) {
    const proto =
      reqHeaders.get("x-forwarded-proto") ??
      (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  throw new Error("Could not resolve app base URL");
}

export type SendInviteResult =
  | { emailed: true }
  | { emailed: false; warning: string };

// Email a one-click invite link that lands on `${baseUrl}/invite/{token}`.
//
// For a brand-new email, admin.inviteUserByEmail creates an auth.users row in
// invited state and sends Supabase's "Invite User" template. For an email that
// already has a Canvas auth account, inviteUserByEmail errors — we fall back to
// a magic-link (OTP) email so they still get a one-click landing on /invite.
//
// Never throws on a send failure: the invite row already exists and the link is
// copy-pasteable from the pending list, so we return a warning instead.
export async function sendInviteLink(
  email: string,
  token: string,
  data: Record<string, unknown>,
): Promise<SendInviteResult> {
  const baseUrl = await resolveAppBaseUrl();
  const redirectTo = `${baseUrl}/invite/${token}`;
  const admin = createAdminClient();

  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data,
  });
  if (!inviteErr) return { emailed: true };

  const msg = inviteErr.message.toLowerCase();
  const userAlreadyExists =
    msg.includes("already") ||
    msg.includes("registered") ||
    inviteErr.status === 422;

  if (userAlreadyExists) {
    const supabase = await createClient();
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    });
    if (otpErr) {
      return {
        emailed: false,
        warning: `Invite created, but the email could not be sent (${otpErr.message}). Use "Copy link" to share it manually.`,
      };
    }
    return { emailed: true };
  }

  return {
    emailed: false,
    warning: `Invite created, but the email could not be sent (${inviteErr.message}). Use "Copy link" to share it manually.`,
  };
}
