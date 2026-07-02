import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { displayName } from "@/lib/utils";
import {
  asProposalKind,
  asProposerKind,
  compareReviewOrder,
} from "@/lib/canvas/proposal-types";
import { eligibleForBatch } from "@/lib/canvas/batch-approve";
import { InboxProposalList, type InboxProposalRow } from "./proposal-list";
import { ApproveAllButton } from "./approve-all-button";

// /canvases/inbox
//
// Two-section view of canvas_deck_edit rows in the active workspace.
//
//   "To review" — pending proposals I'm not the author of. RLS already
//   filters by workspace membership so everything visible is in scope; we
//   intentionally don't pre-filter by "I can approve" because workspace
//   admins can approve anything and the affordance is decided per-row on
//   the detail page anyway.
//
//   "My proposals" — every proposal I authored, any status. Lets a Claude
//   user (or human) see their queue + audit trail. The list is interactive
//   for every status, not just pending: clicking a past (applied / rejected
//   / superseded) row pops the same proposal sheet as a pending row, with
//   the apply/reject affordances hidden by the sheet itself. Read-only
//   reuse of the sheet means a Claude user can revisit *why* a proposal was
//   rejected without leaving the inbox.

type RawProposalRow = {
  id: string;
  deck_id: string;
  slide_id: string | null;
  kind: string;
  proposed_by: string;
  proposed_by_kind: string;
  status: string;
  rationale: string | null;
  created_at: string;
  // Base version the proposal was made against — feeds the shared batch
  // eligibility rule's staleness test (lib/canvas/batch-approve).
  base_version_id: string | null;
};

export default async function InboxPage() {
  const { user, workspace } = await getActiveWorkspace("/canvases/inbox");
  const supabase = await createClient();

  // Two parallel queries — toReview and mine — keep the logic readable. Both
  // are scoped to the ACTIVE workspace: RLS only constrains them to proposals
  // the user MAY see, which spans every workspace they belong to, so the
  // explicit workspace_id filter is what keeps the inbox showing one
  // workspace's review queue rather than the union across all of them (uses the
  // (workspace_id, status) index).
  const [toReviewResp, mineResp] = await Promise.all([
    supabase
      .from("canvas_deck_edit")
      .select(
        "id, deck_id, slide_id, kind, proposed_by, proposed_by_kind, status, rationale, created_at, base_version_id",
      )
      .eq("workspace_id", workspace.id)
      .eq("status", "pending")
      .neq("proposed_by", user.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("canvas_deck_edit")
      .select(
        "id, deck_id, slide_id, kind, proposed_by, proposed_by_kind, status, rationale, created_at, base_version_id",
      )
      .eq("workspace_id", workspace.id)
      .eq("proposed_by", user.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const toReview: RawProposalRow[] = toReviewResp.data ?? [];
  const mine: RawProposalRow[] = mineResp.data ?? [];

  // Lookups — deck titles, slide positions, proposer names. Batch up the IDs
  // we need so we don't N+1.
  const allRows = [...toReview, ...mine];
  const deckIds = Array.from(new Set(allRows.map((r) => r.deck_id)));
  const slideIds = Array.from(
    new Set(allRows.map((r) => r.slide_id).filter((v): v is string => Boolean(v))),
  );
  const proposerIds = Array.from(new Set(allRows.map((r) => r.proposed_by)));

  const [decks, slides, users] = await Promise.all([
    deckIds.length
      ? supabase.from("canvas_deck").select("id, title").in("id", deckIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
    slideIds.length
      ? supabase
          .from("canvas_deck_slide")
          .select("id, position, title")
          .in("id", slideIds)
      : Promise.resolve({
          data: [] as { id: string; position: number; title: string }[],
        }),
    proposerIds.length
      ? supabase
          .from("users")
          .select("id, email, name")
          .in("id", proposerIds)
      : Promise.resolve({
          data: [] as { id: string; email: string | null; name: string | null }[],
        }),
  ]);

  const deckById = new Map((decks.data ?? []).map((d) => [d.id, d.title]));
  const slideById = new Map(
    (slides.data ?? []).map((s) => [s.id, { position: s.position, title: s.title }]),
  );
  const userById = new Map(
    (users.data ?? []).map((u) => [
      u.id,
      displayName({ email: u.email ?? "", name: u.name ?? null }),
    ]),
  );

  // Batch eligibility — the same rule as the editor's "Approve N from
  // Claude" (lib/canvas/batch-approve). The pending universe must include MY
  // pending proposals too (they're not in toReview), or a Claude proposal
  // stacked on a slide I also have a pending edit on would look alone.
  // Staleness needs each touched slide's current version: one extra .in().
  const pendingUniverse = [
    ...toReview,
    ...mine.filter((r) => r.status === "pending"),
  ];
  const pendingSlideIds = Array.from(
    new Set(
      pendingUniverse
        .map((r) => r.slide_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const slideVersions = pendingSlideIds.length
    ? await supabase
        .from("canvas_deck_slide")
        .select("id, current_version_id")
        .in("id", pendingSlideIds)
    : { data: [] as { id: string; current_version_id: string | null }[] };
  const currentVersionBySlide = new Map(
    (slideVersions.data ?? []).map((s) => [s.id, s.current_version_id]),
  );
  const toReviewIds = new Set(toReview.map((r) => r.id));
  const batchEligible = eligibleForBatch(
    pendingUniverse,
    currentVersionBySlide,
  ).filter((r) => toReviewIds.has(r.id));

  function enrich(row: RawProposalRow): InboxProposalRow {
    const slideInfo = row.slide_id ? slideById.get(row.slide_id) : null;
    return {
      id: row.id,
      deck_id: row.deck_id,
      deck_title: deckById.get(row.deck_id) ?? "Deck",
      // slide_id drives the row's thumbnail URL (proposed-state preview); the
      // position/title drive the text label.
      slide_id: row.slide_id,
      slide_position: slideInfo?.position ?? null,
      slide_title: slideInfo?.title ?? null,
      // Supabase returns these enum columns as raw `string`. Narrow at the
      // boundary so downstream consumers (and TS narrowing) get the
      // discriminator back. The helpers log + fall back rather than throw,
      // so a stray row can't blank out the inbox.
      kind: asProposalKind(row.kind),
      proposer_name: userById.get(row.proposed_by) ?? null,
      proposed_by_kind: asProposerKind(row.proposed_by_kind),
      status: row.status,
      rationale: row.rationale,
      created_at: row.created_at,
    };
  }

  // "To review" is an actionable queue, so order it the way a reviewer works:
  // group each deck's proposals together (freshest deck-group first, so newly
  // active decks stay near the top), then walk each deck in review order —
  // structural edits, then slide-by-slide top-to-bottom. See compareReviewOrder.
  const deckNewest = new Map<string, string>();
  for (const r of toReview) {
    const cur = deckNewest.get(r.deck_id);
    if (!cur || r.created_at > cur) deckNewest.set(r.deck_id, r.created_at);
  }
  const toReviewRows = toReview.map(enrich).sort((a, b) => {
    if (a.deck_id !== b.deck_id) {
      const an = deckNewest.get(a.deck_id) ?? "";
      const bn = deckNewest.get(b.deck_id) ?? "";
      if (an !== bn) return an < bn ? 1 : -1; // newest deck-group first
      return a.deck_id < b.deck_id ? -1 : 1; // stable tie-break
    }
    return compareReviewOrder(a, b);
  });
  // "My proposals" is an audit trail across every status, so it stays
  // newest-first (the DB order) — a log reads better by time than by position.
  const mineRows = mine.map(enrich);

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Proposals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edits proposed by connected agents or workspace members. You review the
          diff and approve before changes ship to the deck.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="eyebrow text-muted-foreground">To review</div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {toReview.length} pending
            </span>
            <ApproveAllButton
              proposals={batchEligible.map((r) => ({
                editId: r.id,
                deckId: r.deck_id,
              }))}
            />
          </div>
        </div>
        <InboxProposalList
          rows={toReviewRows}
          emptyLabel="Nothing to review. New proposals show up here."
          openFullDiff
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <div className="eyebrow text-muted-foreground">My proposals</div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {mine.length} total
          </span>
        </div>
        <InboxProposalList
          rows={mineRows}
          emptyState={
            <div className="rounded-[12px] border border-dashed border-border bg-card/50 p-6 text-center text-sm text-muted-foreground">
              <p>You haven&apos;t proposed any edits yet.</p>
              <p className="mt-1">
                Connect an agent via{" "}
                <Link
                  href="/settings/mcp"
                  className="font-medium text-[color:var(--accent)] hover:underline"
                >
                  Connections
                </Link>{" "}
                to propose changes from chat.
              </p>
            </div>
          }
          showProposer={false}
        />
      </section>
    </main>
  );
}
