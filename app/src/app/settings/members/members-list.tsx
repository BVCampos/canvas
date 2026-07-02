"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { changeRole, removeMember } from "@/lib/actions/members";
import { displayName, initials, relativeDate } from "@/lib/utils";
import type { WorkspaceRole } from "@/lib/auth/workspace";

type Member = {
  membership_id: string;
  user_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
  joined_at: string;
  is_self: boolean;
};

// Guests are intentionally absent: they're created only via a deck-scoped
// invite (the share dialog), not promoted/demoted from the roster, and
// changeRole rejects 'guest'. A guest row renders as a read-only badge below.
const ROLE_OPTIONS: { value: WorkspaceRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

export function MembersList({
  members,
  actorRole,
  guestDecks,
}: {
  members: Member[];
  actorRole: WorkspaceRole;
  // user_id -> the decks each guest can reach (their explicit per-deck grants),
  // so the roster can show what an outside reviewer actually has access to.
  guestDecks?: Record<string, { title: string; role: string }[]>;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRoleChange(membershipId: string, newRole: WorkspaceRole) {
    setBusyId(membershipId);
    setError(null);
    const result = await changeRole(membershipId, newRole);
    setBusyId(null);
    if (result && "error" in result && result.error) {
      setError(result.error);
    }
    router.refresh();
  }

  async function handleRemove(membershipId: string, label: string) {
    if (!window.confirm(`Remove ${label} from the workspace?`)) return;
    setBusyId(membershipId);
    setError(null);
    const result = await removeMember(membershipId);
    setBusyId(null);
    if (result && "error" in result && result.error) {
      setError(result.error);
    }
    router.refresh();
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
      {members.map((m) => {
        const label = displayName({ email: m.email, name: m.name });
        const isGuest = m.role === "guest";
        // Admins can't touch Owners; the self-row hides remove (server also
        // rejects). Owners can do anything except demote/remove the last Owner
        // — that check is server-side too.
        const canManageTarget =
          (actorRole === "owner" || (actorRole === "admin" && m.role !== "owner")) &&
          !m.is_self;
        // Guests have no editable role (deck-scoped only), but can still be
        // removed from the workspace.
        const canEditRole = canManageTarget && !isGuest;
        const canRemove = canManageTarget;

        return (
          // On mobile the meta (email + joined) needs the full width, so the
          // role/remove controls wrap to a second line; from sm+ it's the
          // original single inline row. items-start avoids the avatar jumping
          // when the row grows to two lines.
          <li
            key={m.membership_id}
            className="flex flex-col items-start gap-2 rounded-[8px] border bg-card px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
          >
            {/* Identity block: avatar + name/email. min-w-0 lets the email
                truncate instead of forcing horizontal overflow. */}
            <div className="flex min-w-0 flex-1 items-center gap-3 self-stretch">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground overflow-hidden">
                {m.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.avatar_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  initials(label)
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {label}
                  {m.is_self && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">(you)</span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {m.email} · joined {relativeDate(m.joined_at)}
                </div>
                {isGuest && (
                  <div
                    className="text-[11px] text-muted-foreground truncate"
                    title={
                      guestDecks?.[m.user_id]
                        ?.map((d) => `${d.title} (${d.role})`)
                        .join(", ") || undefined
                    }
                  >
                    {guestDecks?.[m.user_id]?.length
                      ? `Access: ${guestDecks[m.user_id]
                          .map((d) => `${d.title} (${d.role})`)
                          .join(", ")}`
                      : "No deck access"}
                  </div>
                )}
              </div>
            </div>
            {/* Controls cluster: wraps under the identity on mobile, sits inline
                at sm+. self-end keeps it right-aligned on the second line. */}
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              {isGuest ? (
                <span
                  title="Outside reviewer — access is limited to the specific decks they were invited to"
                  className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  Guest
                </span>
              ) : canEditRole ? (
                // text-base on mobile dodges iOS focus-zoom (back to xs at sm+);
                // h-9 (36px) is a usable touch target, shrinking to h-7 on desktop.
                <select
                  value={m.role}
                  onChange={(e) =>
                    handleRoleChange(m.membership_id, e.target.value as WorkspaceRole)
                  }
                  disabled={busyId === m.membership_id}
                  aria-label={`Change role for ${label}`}
                  className="h-9 rounded-[6px] border bg-card px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:text-xs"
                >
                  {ROLE_OPTIONS.filter(
                    // Only Owners can promote to Owner. Hide the option from Admins.
                    (opt) => opt.value !== "owner" || actorRole === "owner",
                  ).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-muted-foreground capitalize px-2">
                  {m.role}
                </span>
              )}
              {/* Bigger square tap target on mobile (h-9/w-9 = 36px), back to
                  the compact inline padding at sm+. */}
              {canRemove && (
                <button
                  onClick={() => handleRemove(m.membership_id, label)}
                  disabled={busyId === m.membership_id}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-xs text-muted-foreground hover:text-destructive hover:bg-muted transition-colors disabled:opacity-40 sm:h-auto sm:w-auto sm:px-2 sm:py-1"
                  aria-label="Remove member"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </li>
        );
      })}
      </ul>
    </div>
  );
}
