"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { approveAllProposals } from "@/app/canvases/proposal-actions";

// Bulk-approve affordance for the inbox "To review" section. The page only
// passes the BATCH-ELIGIBLE subset (claude-authored, non-stale, target has
// exactly one pending — the shared rule in lib/canvas/batch-approve), and
// approveAllProposals re-verifies the same rule server-side before applying
// each id; canvas_apply_edit enforces permissions on top. Any per-row
// denial comes back in `failed` and is surfaced inline. Hidden when nothing
// qualifies — the ineligible remainder is reviewed row by row.

type Pending = { editId: string; deckId: string };

export function ApproveAllButton({ proposals }: { proposals: Pending[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  if (proposals.length === 0) return null;

  function run() {
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await approveAllProposals(proposals);
      setConfirming(false);
      if (result.failed.length > 0) {
        const sample = result.failed
          .slice(0, 2)
          .map((f) => f.error)
          .join("; ");
        const more =
          result.failed.length > 2 ? ` (+${result.failed.length - 2} more)` : "";
        setError(
          `Approved ${result.approved}, ${result.failed.length} failed: ${sample}${more}`,
        );
      } else {
        setOkMessage(`Approved ${result.approved}.`);
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Apply {proposals.length} from agents?
          </span>
          <Button onClick={run} disabled={isPending} size="sm">
            {isPending ? "Approving…" : "Yes, approve all"}
          </Button>
          <Button
            onClick={() => setConfirming(false)}
            disabled={isPending}
            variant="ghost"
            size="sm"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            setOkMessage(null);
            setConfirming(true);
          }}
          disabled={isPending}
        >
          Approve {proposals.length} from agents
        </Button>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-[6px] border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-900 dark:border-rose-400/40 dark:bg-rose-500/10 dark:text-rose-200"
        >
          {error}
        </p>
      )}
      {okMessage && (
        <p
          role="status"
          className="text-[11px] text-emerald-700 dark:text-emerald-300"
        >
          {okMessage}
        </p>
      )}
    </div>
  );
}
