"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inviteMember } from "@/lib/actions/members";

export function InviteForm({ canInviteOwner }: { canInviteOwner: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Capture the form ref now; React nullifies e.currentTarget after await.
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    setSuccess(null);
    setWarning(null);
    const fd = new FormData(form);
    const result = await inviteMember(fd);
    if (result && "error" in result && result.error) {
      setError(result.error);
    } else {
      if (result && "warning" in result && result.warning) {
        setWarning(result.warning);
      } else {
        setSuccess("Invite sent. The invitee will get an email with a Join link.");
      }
      form.reset();
      router.refresh();
    }
    setPending(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start"
    >
      <div className="flex-1">
        <Input
          name="email"
          type="email"
          required
          placeholder="teammate@company.com"
          disabled={pending}
        />
      </div>
      {/* Full-width + h-10 + text-base on mobile so the select matches the
          stacked Input above (and text-base avoids iOS focus-zoom). At sm+ it
          returns to the fixed 8rem / h-9 / 14px inline control. */}
      <select
        name="role"
        defaultValue="member"
        disabled={pending}
        aria-label="Invite role"
        className="flex h-10 w-full rounded-[8px] border bg-card px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-32 sm:text-sm"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        {canInviteOwner && <option value="owner">Owner</option>}
      </select>
      <Button type="submit" disabled={pending}>
        <Mail className="h-3.5 w-3.5" /> {pending ? "Sending…" : "Send invite"}
      </Button>
      {error && (
        <p className="basis-full text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {warning && (
        <p className="basis-full text-xs text-warning-fg" role="status">
          {warning}
        </p>
      )}
      {success && (
        <p className="basis-full text-xs text-success-fg" role="status">
          {success}
        </p>
      )}
    </form>
  );
}
