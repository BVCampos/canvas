"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateDisplayNameAction } from "@/lib/auth/actions";

const RENAME_ERROR_COPY: Record<string, string> = {
  name_required: "Display name is required.",
  name_too_long: "Display name must be 60 characters or fewer.",
  not_authenticated: "Your session expired — sign in again.",
};

// Display-name editor, mirroring the read-then-edit shape of the workspace
// rename on /settings/workspace. Email is shown read-only: accounts are
// keyed on it (magic-link sign-in), so changing it is not offered here.
export function ProfileForm({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await updateDisplayNameAction(new FormData(e.currentTarget));
    setPending(false);
    if (!result.ok) {
      setError(RENAME_ERROR_COPY[result.error] ?? result.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-4">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium text-foreground">{name}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="text-foreground">{email}</dd>
        </dl>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="max-w-sm space-y-1.5">
        <label
          htmlFor="profile-name-input"
          className="text-xs font-medium text-foreground"
        >
          Display name
        </label>
        <Input
          id="profile-name-input"
          name="name"
          autoFocus
          required
          maxLength={60}
          defaultValue={name}
          disabled={pending}
        />
        <p className="text-[11px] text-muted-foreground">
          Shown to teammates in the members list, comments, and proposal
          history. Signed in as{" "}
          <span className="font-medium text-foreground">{email}</span>.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
