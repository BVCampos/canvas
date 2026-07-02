"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, Link2Off, FileText, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revokeDeckPublicLink, revokeProjectPublicLink } from "./actions";

export type PublicLink = {
  kind: "deck" | "project";
  id: string;
  name: string;
  visibility: string | null;
  url: string;
};

export function PublicLinksList({ links }: { links: PublicLink[] }) {
  const router = useRouter();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (links.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Nothing in this workspace is shared by public link.
      </p>
    );
  }

  async function copy(id: string, url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  }

  function handleRevoke(link: PublicLink) {
    if (
      !window.confirm(
        `Turn off the public link for "${link.name}"? Anyone currently holding the link will lose access immediately.`,
      )
    ) {
      return;
    }
    setError(null);
    setBusyId(link.id);
    startTransition(async () => {
      const res =
        link.kind === "deck"
          ? await revokeDeckPublicLink(link.id)
          : await revokeProjectPublicLink(link.id);
      setBusyId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y divide-border rounded-[8px] border border-border">
        {links.map((link) => {
          const busy = busyId === link.id;
          return (
            <li
              key={`${link.kind}:${link.id}`}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="text-muted-foreground shrink-0">
                {link.kind === "deck" ? (
                  <FileText className="size-4" />
                ) : (
                  <FolderOpen className="size-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{link.name}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {link.kind}
                  </span>
                </div>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-xs text-muted-foreground hover:text-foreground"
                >
                  {link.url}
                </a>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(link.id, link.url)}
                className="shrink-0"
              >
                {copiedId === link.id ? <Check /> : <Copy />}
                {copiedId === link.id ? "Copied" : "Copy"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleRevoke(link)}
                disabled={busy}
                className="shrink-0"
              >
                <Link2Off />
                {busy ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
