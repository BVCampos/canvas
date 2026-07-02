"use client";

import { useState } from "react";

// Sandboxed iframe with a skeleton overlay until the iframe's onLoad fires.
// Used inside the proposal diff for before/after previews. Lives as a client
// component because onLoad is a client event; the assembled HTML string is
// computed server-side and passed in.

export function ProposalIframe({
  html,
  title,
  className = "",
}: {
  html: string;
  title: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={`relative overflow-hidden rounded-[8px] border border-border bg-card ${className}`}
    >
      {!loaded && (
        <div
          aria-hidden
          className="absolute inset-0 z-10 animate-pulse bg-muted/40"
        />
      )}
      <iframe
        srcDoc={html}
        sandbox="allow-scripts"
        title={title}
        onLoad={() => setLoaded(true)}
        loading="eager"
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
