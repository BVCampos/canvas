"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createWorkspaceAction } from "@/lib/auth/actions";

// Client form for /no-workspace. Posts to createWorkspaceAction; on success
// we land on /canvases (the action has already switched the active-workspace
// cookie, so resolveActiveWorkspace will pick up the new tenant).
const ERROR_COPY: Record<string, string> = {
  name_required: "Workspace name is required.",
  name_too_long: "Workspace name must be 60 characters or fewer.",
  not_authenticated: "Your session expired — sign in again.",
};

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    const fd = new FormData(form);
    const result = await createWorkspaceAction(fd);
    if (!result.ok) {
      setError(ERROR_COPY[result.error] ?? result.error);
      setPending(false);
      return;
    }
    // The server action already wrote the active-workspace cookie + ran
    // revalidatePath("/", "layout"). Refresh + push so the next render
    // resolves the new tenancy without a stale layout flash.
    router.refresh();
    router.push("/canvases");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <label
          htmlFor="workspace-name"
          className="text-xs font-medium text-foreground"
        >
          Workspace name
        </label>
        <Input
          id="workspace-name"
          name="name"
          autoFocus
          required
          maxLength={60}
          placeholder="Acme Inc."
          disabled={pending}
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
