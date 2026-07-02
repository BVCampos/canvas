import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { displayName, formatDate, relativeDate } from "@/lib/utils";
import { buildDeckActivity } from "@/lib/canvas/activity";
import type {
  ActivityCommentRow,
  ActivityEditRow,
  ActivityLogRow,
} from "@/lib/canvas/activity";
import { ActivityFeed } from "./activity-feed";
import { HistoryView } from "./history-view";

// /canvases/{id}/history — phase 4.
//
// Two stacked sections: deck snapshots (with restore) and per-slide version
// history (slide picker + version list with restore). Both call the SECURITY
// INVOKER RPC functions added in migration 0002 so RLS enforces who can
// restore (today: any workspace member).

export default async function CanvasHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ slide?: string }>;
}) {
  const { id } = await params;
  // Optional ?slide=<id> deep-link from the editor's v{N} label — pre-selects
  // that slide in the version list (HistoryView seeds selectedSlideId from it).
  const { slide: initialSlideId } = await searchParams;
  const supabase = await createClient();

  // theme_css / nav_js / meta feed the version-diff preview iframes (ProposalDiff
  // assembles each version's slide inside the deck's theme).
  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("id, title, theme_css, nav_js, meta, created_by, created_at")
    .eq("id", id)
    .maybeSingle();
  if (!deck) notFound();

  const { data: snapshots } = await supabase
    .from("canvas_deck_snapshot")
    .select("id, label, description, kind, created_at, created_by")
    .eq("deck_id", id)
    .order("created_at", { ascending: false });

  const { data: slides } = await supabase
    .from("canvas_deck_slide")
    .select("id, position, title, current_version_id")
    .eq("deck_id", id)
    .order("position", { ascending: true });

  const slideIds = (slides ?? []).map((s) => s.id);
  const { data: versions } = slideIds.length
    ? await supabase
        .from("canvas_slide_version")
        .select(
          "id, slide_id, version_no, author_kind, created_by, source_prompt, source_edit_id, created_at",
        )
        .in("slide_id", slideIds)
        .order("version_no", { ascending: false })
    : { data: [] };

  // Per-snapshot impact: how many of the deck's current slides would change if
  // this snapshot were restored. A slide "changes" when the snapshot's captured
  // version for its position differs from the slide's current version. Read-only
  // and batched (one query for all snapshots); surfaced in the restore confirm.
  const snapshotIds = (snapshots ?? []).map((s) => s.id);
  const { data: snapSlides } = snapshotIds.length
    ? await supabase
        .from("canvas_deck_snapshot_slide")
        .select("snapshot_id, position, slide_version_id, slide_id")
        .in("snapshot_id", snapshotIds)
    : {
        data: [] as {
          snapshot_id: string;
          position: number;
          slide_version_id: string | null;
          slide_id: string | null;
        }[],
      };
  // Mirror canvas_restore_snapshot's semantics (migration 0061): it advances
  // each captured slide that still exists AND reconstructs ones that were
  // deleted since the snapshot — it does NOT match by position. Resolve each
  // snapshot row's target slide by its denormalized slide_id (which survives the
  // slide's deletion), falling back to the version → slide map for legacy rows
  // captured before slide_id was denormalized. A target that no longer exists
  // would be REBUILT by restore, so it counts as both a target and an impact.
  const slideIdByVersionId = new Map(
    (versions ?? []).map((v) => [v.id, v.slide_id]),
  );
  const currentVersionBySlideId = new Map(
    (slides ?? []).map((s) => [s.id, s.current_version_id]),
  );
  const impactBySnapshot = new Map<string, number>();
  const targetCountBySnapshot = new Map<string, number>();
  for (const row of snapSlides ?? []) {
    const slideId =
      row.slide_id ??
      (row.slide_version_id
        ? slideIdByVersionId.get(row.slide_version_id)
        : undefined);
    if (slideId === undefined || slideId === null) continue; // unknowable legacy target
    targetCountBySnapshot.set(
      row.snapshot_id,
      (targetCountBySnapshot.get(row.snapshot_id) ?? 0) + 1,
    );
    const current = currentVersionBySlideId.get(slideId);
    // Slide gone → restore reconstructs it (impact). Slide present but at a
    // different version → restore advances it (impact). Same version → no-op.
    if (current === undefined || current !== row.slide_version_id) {
      impactBySnapshot.set(
        row.snapshot_id,
        (impactBySnapshot.get(row.snapshot_id) ?? 0) + 1,
      );
    }
  }

  // --- Activity feed inputs ---------------------------------------------
  // Proposals (every status — applied reads as the action, rejected/pending
  // as the resolution/open item, superseded as "set aside"), comments, and the
  // direct-structural-op log (canvas_deck_activity — slide deletes the CASCADE
  // would erase, migration 0037; direct draw-create + duplicate, migration
  // 0073). payload_title pulls just the title out of new_slide_payload so we
  // don't ship whole proposed slide bodies.
  const { data: editRows, error: editRowsError } = await supabase
    .from("canvas_deck_edit")
    .select(
      "id, kind, status, slide_id, proposed_by, proposed_by_kind, resolved_by, rationale, payload_title:new_slide_payload->>title, created_at, resolved_at",
    )
    .eq("deck_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  const { data: commentRows, error: commentRowsError } = await supabase
    .from("canvas_comment")
    .select("id, slide_id, parent_id, author_kind, author_id, author_name, body, created_at")
    .eq("deck_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  const { data: activityRows, error: activityRowsError } = await supabase
    .from("canvas_deck_activity")
    .select("id, action, actor_id, actor_kind, subject_user_id, detail, created_at")
    .eq("deck_id", id)
    .order("created_at", { ascending: false })
    .limit(500);

  // The feed is an audit surface, so a failed source must not be
  // indistinguishable from an empty one (e.g. canvas_deck_activity missing
  // because migration 0037 wasn't applied would silently erase every slide
  // deletion from the timeline — the exact gap the table exists to close).
  // Log each failure and tell the reader the feed may be incomplete.
  const failedFeedSources: string[] = [];
  for (const [source, error] of [
    ["proposals", editRowsError],
    ["comments", commentRowsError],
    ["deletion log", activityRowsError],
  ] as const) {
    if (error) {
      console.error(
        `[history] activity feed source "${source}" failed for deck ${id}: ${error.message}`,
      );
      failedFeedSources.push(source);
    }
  }

  const userIds = Array.from(
    new Set(
      [
        deck.created_by,
        ...((snapshots ?? []).map((s) => s.created_by)),
        ...((versions ?? []).map((v) => v.created_by)),
        ...((editRows ?? []).flatMap((e) => [e.proposed_by, e.resolved_by])),
        ...((commentRows ?? []).map((c) => c.author_id)),
        ...((activityRows ?? []).flatMap((a) => [a.actor_id, a.subject_user_id])),
      ].filter((v): v is string => Boolean(v)),
    ),
  );
  const { data: users, error: usersError } = userIds.length
    ? await supabase.from("users").select("id, email, name").in("id", userIds)
    : {
        data: [] as { id: string; email: string | null; name: string | null }[],
        error: null,
      };
  if (usersError) {
    // A failed lookup degrades every actor to "Unknown user" — flag it so the
    // feed doesn't pass that off as resolved data.
    console.error(
      `[history] users lookup failed for deck ${id}: ${usersError.message}`,
    );
    failedFeedSources.push("user names");
  }
  // Pre-resolve display labels (name preferred, email-prefix fallback) so the
  // History view doesn't have to know about the `users` table or our display
  // rules. Two users with the same first-name local-part still disambiguate
  // because we surface `name` from auth user_metadata when available.
  const displayById = new Map(
    (users ?? []).map((u) => [
      u.id,
      displayName({ name: u.name ?? null, email: u.email ?? "" }) || "Unknown user",
    ]),
  );

  // Merge everything into the chronological "who did what" feed. Capped so a
  // long-lived deck doesn't ship an unbounded payload; dates pre-formatted
  // here so the client component stays dumb.
  const activityEvents = buildDeckActivity(
    {
      deck: {
        id: deck.id,
        created_by: deck.created_by ?? null,
        created_at: deck.created_at,
      },
      slides: (slides ?? []).map((s) => ({
        id: s.id,
        position: s.position,
        title: s.title,
      })),
      edits: (editRows ?? []) as ActivityEditRow[],
      versions: versions ?? [],
      snapshots: snapshots ?? [],
      comments: (commentRows ?? []) as ActivityCommentRow[],
      log: ((activityRows ?? []) as ActivityLogRow[]).map((a) => ({
        ...a,
        detail: (a.detail ?? {}) as Record<string, unknown>,
      })),
    },
    displayById,
  )
    .slice(0, 300)
    .map((e) => ({
      ...e,
      at_formatted: formatDate(e.at),
      at_relative: relativeDate(e.at),
    }));

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 space-y-8 sm:px-6">
      <div className="flex items-end justify-between">
        <div>
          <Link
            href={`/canvases/${deck.id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to deck
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{deck.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Snapshots are named cuts of the whole deck. Slide versions are the
            append-only log of every edit. Restores are forward-only — they
            create a new version, never overwrite history.
          </p>
        </div>
      </div>

      <ActivityFeed events={activityEvents} failedSources={failedFeedSources} />

      <HistoryView
        deckId={deck.id}
        deckTitle={deck.title}
        themeCss={deck.theme_css ?? ""}
        navJs={deck.nav_js ?? ""}
        deckMeta={(deck.meta ?? null) as Record<string, unknown> | null}
        initialSlideId={initialSlideId ?? null}
        snapshots={(() => {
          // Disambiguate snapshots that share a label. The UX problem: two
          // "Pre-export 2026-05-25 17:05" rows look like duplicates even
          // though they're distinct snapshots with different ids. We append
          // a short suffix to the second-and-later collisions:
          //   - " (2)", " (3)", ... within the same label group
          //   - the first occurrence keeps the bare label
          // Snapshots are sorted newest-first; we count occurrences going
          // forward (oldest occurrence wins the bare label so historical
          // links remain stable on relabel/restore). The display label is
          // computed here so the client view stays dumb.
          const rows = snapshots ?? [];
          const labelCounts = new Map<string, number>();
          for (const s of rows) {
            const k = (s.label as string) ?? "";
            labelCounts.set(k, (labelCounts.get(k) ?? 0) + 1);
          }
          // Walk in chronological order (oldest first) to assign suffixes,
          // then re-sort newest-first for render. Using created_at as the
          // tiebreaker keeps the assignment deterministic across requests.
          const chrono = [...rows].sort((a, b) =>
            (a.created_at as string) < (b.created_at as string) ? -1 : 1,
          );
          const seen = new Map<string, number>();
          const displayLabelById = new Map<string, string>();
          for (const s of chrono) {
            const label = (s.label as string) ?? "";
            const total = labelCounts.get(label) ?? 1;
            const idx = (seen.get(label) ?? 0) + 1;
            seen.set(label, idx);
            // Single-occurrence labels render bare. Collisions get " (n)".
            displayLabelById.set(
              s.id as string,
              total <= 1 ? label : `${label} (${idx})`,
            );
          }
          return rows.map((s) => ({
            ...s,
            label: displayLabelById.get(s.id as string) ?? (s.label as string),
            created_by_label: s.created_by
              ? displayById.get(s.created_by) ?? null
              : null,
            created_at_formatted: formatDate(s.created_at),
            created_at_relative: relativeDate(s.created_at),
            changed_count: impactBySnapshot.get(s.id as string) ?? 0,
            total_slides: targetCountBySnapshot.get(s.id as string) ?? 0,
          }));
        })()}
        slides={(slides ?? []).map((s) => ({
          id: s.id,
          position: s.position,
          title: s.title,
          current_version_id: s.current_version_id ?? null,
        }))}
        versions={(versions ?? []).map((v) => ({
          ...v,
          created_by_label: v.created_by ? displayById.get(v.created_by) ?? null : null,
          created_at_formatted: formatDate(v.created_at),
          created_at_relative: relativeDate(v.created_at),
        }))}
      />
    </main>
  );
}
