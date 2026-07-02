"use client";

import Link from "next/link";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NewDeckSourceTabs } from "./source-tabs";

type Project = { id: string; name: string };

export function NewDeckForm({
  projects,
  preselectedProject,
}: {
  projects: Project[];
  preselectedProject: string;
}) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      method="post"
      action="/api/decks/import"
      encType="multipart/form-data"
      onSubmit={() => setSubmitting(true)}
      aria-busy={submitting}
      className="space-y-5 rounded-[12px] border border-border bg-card p-4 sm:p-6"
    >
      <div className="space-y-2">
        <label
          htmlFor="new-deck-title"
          className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
        >
          Deck title
        </label>
        <Input
          id="new-deck-title"
          type="text"
          placeholder="Proposal name"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          autoFocus
        />
      </div>

      <NewDeckSourceTabs
        onSuggestedTitle={(suggestion) => {
          if (!title.trim()) setTitle(suggestion);
        }}
      />

      {projects.length > 0 ? (
        <div className="space-y-2">
          <label
            htmlFor="new-deck-project"
            className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            Project <span className="font-normal normal-case">(optional)</span>
          </label>
          <select
            id="new-deck-project"
            name="project_id"
            defaultValue={preselectedProject}
            className="flex h-9 w-full rounded-[8px] border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Visibility
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <VisibilityOption
            value="workspace"
            title="Workspace"
            description="Everyone in the workspace can view and edit."
            defaultChecked
          />
          <VisibilityOption
            value="private"
            title="Private"
            description="Only invited people can access it. Admins can still see it."
          />
        </div>
      </fieldset>

      {submitting ? (
        <div className="rounded-[10px] border border-[color:var(--accent)]/30 bg-[color:var(--accent-wash)] px-4 py-3" role="status">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LoaderCircle aria-hidden className="h-4 w-4 animate-spin text-[color:var(--accent)]" />
            Importing and splitting slides…
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div className="h-full w-2/3 animate-pulse rounded-full bg-[color:var(--accent)]" />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Keep this page open. Large embedded images can take a little longer.
          </p>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button asChild variant="ghost">
          <Link href="/canvases">Cancel</Link>
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create deck"}
        </Button>
      </div>
    </form>
  );
}

function VisibilityOption({
  value,
  title,
  description,
  defaultChecked = false,
}: {
  value: string;
  title: string;
  description: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-[10px] border border-border bg-card p-3 text-sm hover:border-ring/40 has-[:checked]:border-ring has-[:checked]:bg-mist/60">
      <input
        type="radio"
        name="visibility"
        value={value}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

