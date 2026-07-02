"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, X, Send } from "lucide-react";
import { revokeInvite, resendInvite } from "@/lib/actions/members";
import { relativeDate } from "@/lib/utils";

type Invite = {
  id: string;
  email: string;
  role: string;
  token: string;
  expires_at: string;
};

export function InvitesList({
  invites,
  appBaseUrl,
}: {
  invites: Invite[];
  appBaseUrl: string;
}) {
  const router = useRouter();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (invites.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">No pending invites.</p>
    );
  }

  async function copy(id: string, url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(
      () => setCopiedId((current) => (current === id ? null : current)),
      1500,
    );
  }

  async function handleRevoke(id: string) {
    if (!window.confirm("Revoke this invite?")) return;
    setBusyId(id);
    setError(null);
    const result = await revokeInvite(id);
    setBusyId(null);
    if (result && "error" in result && result.error) {
      setError(result.error);
    }
    router.refresh();
  }

  async function handleResend(id: string) {
    setBusyId(id);
    setError(null);
    const result = await resendInvite(id);
    setBusyId(null);
    if (result && "error" in result && result.error) {
      setError(result.error);
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <p
          role="alert"
          className="rounded-[8px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
      {invites.map((inv) => {
        const url = `${appBaseUrl}/invite/${inv.token}`;
        const expired = new Date(inv.expires_at) < new Date();
        return (
          // Stack the action buttons under the email/role meta on mobile so
          // three labeled buttons never overflow a 360px row; inline at sm+.
          <li
            key={inv.id}
            className="flex flex-col items-start gap-2 rounded-[8px] border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1 self-stretch">
              <div className="font-medium truncate">{inv.email}</div>
              <div className="text-[11px] text-muted-foreground">
                {inv.role} · expires{" "}
                <span className={expired ? "text-destructive" : ""}>
                  {relativeDate(inv.expires_at)}
                </span>
              </div>
            </div>
            {/* Action cluster wraps if it runs out of width; each button gets a
                taller (h-9 = 36px) tap target on mobile, compact at sm+. */}
            <div className="flex flex-wrap items-center gap-1.5 self-stretch sm:shrink-0 sm:self-auto sm:gap-2">
              <button
                onClick={() => copy(inv.id, url)}
                className="inline-flex h-9 items-center gap-1 rounded-[6px] px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors sm:h-auto sm:py-1"
                aria-label="Copy invite link"
                title={url}
              >
                {copiedId === inv.id ? (
                  <>
                    <Check className="h-3 w-3 text-success-fg" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" /> Copy link
                  </>
                )}
              </button>
              <button
                onClick={() => handleResend(inv.id)}
                disabled={busyId === inv.id || expired}
                className="inline-flex h-9 items-center gap-1 rounded-[6px] px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 sm:h-auto sm:py-1"
                aria-label="Resend invite email"
              >
                <Send className="h-3 w-3" /> Resend
              </button>
              <button
                onClick={() => handleRevoke(inv.id)}
                disabled={busyId === inv.id}
                className="inline-flex h-9 items-center gap-1 rounded-[6px] px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-muted transition-colors disabled:opacity-40 sm:h-auto sm:py-1"
                aria-label="Revoke invite"
              >
                <X className="h-3 w-3" /> Revoke
              </button>
            </div>
          </li>
        );
      })}
      </ul>
    </div>
  );
}
