"use client";

import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // min-h-dvh keeps the centered card in the visible area on mobile Safari,
  // where 100vh overshoots the viewport because of the collapsing URL bar.
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="flex justify-center">
          <Logo />
        </div>
        <div>
          <div className="eyebrow text-muted-foreground">Error</div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The page couldn&apos;t load. Try again, or head back to your decks.
          </p>
        </div>
        {/* flex-wrap is a safety net at 360px: the two CTAs fit on one row at
            today's copy, but wrapping prevents any horizontal overflow if the
            labels ever grow. No visual change at lg+, where they already fit. */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => reset()}>Try again</Button>
          <Button asChild variant="outline">
            <Link href="/canvases">Back to decks</Link>
          </Button>
        </div>
        {error.digest && (
          <p className="text-[11px] font-mono text-muted-foreground/70">
            {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
