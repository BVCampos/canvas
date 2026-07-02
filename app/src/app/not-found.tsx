import Link from "next/link";
import { Logo } from "@/components/logo";

export default function NotFound() {
  // min-h-dvh keeps the centered card in the visible area on mobile Safari,
  // where 100vh overshoots the viewport because of the collapsing URL bar.
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="flex justify-center">
          <Logo />
        </div>
        <div>
          <div className="eyebrow text-muted-foreground">404</div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            Can&apos;t find that
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The page or deck doesn&apos;t exist, or you don&apos;t have access
            to it in this workspace.
          </p>
        </div>
        <Link
          href="/canvases"
          className="inline-flex text-sm font-medium text-[color:var(--accent)] hover:underline"
        >
          Back to decks →
        </Link>
      </div>
    </div>
  );
}
