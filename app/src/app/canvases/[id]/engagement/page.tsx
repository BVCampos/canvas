import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { relativeDate } from "@/lib/utils";
import {
  aggregateEngagement,
  VIEW_EVENT_OPEN,
  VIEW_EVENT_SLIDE,
  type DeckEngagement,
  type PublicViewRow,
} from "@/lib/canvas/engagement";

// /canvases/{id}/engagement — what recipients did with the public share link.
//
// The recipient-facing sibling of /settings/analytics: opens, unique viewers,
// per-slide dwell, and the drop-off curve, aggregated in TypeScript from the
// surface='public' usage events the track route writes (migration 0063).
//
// Gating: the deck read through the user's RLS client IS the access check —
// anyone who can open the deck can see how its link performed. The event rows
// themselves are read through the admin client because canvas_usage_event has
// admin-only SELECT (0014) and this page's own deck gate is the boundary,
// mirroring the settings/analytics pattern.
//
// Honesty: these numbers come from an unauthenticated surface and are
// self-reported by the viewer's browser. Directional, not billable.

export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;

export default async function DeckEngagementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: deck } = await supabase
    .from("canvas_deck")
    .select("id, title, workspace_id, public_share_token")
    .eq("id", id)
    .maybeSingle();
  if (!deck) notFound();

  // Gate like share management (callerCanManagePublicShare): the RLS deck read
  // only proves the caller can VIEW the deck, but engagement telemetry is an
  // internal surface — a deck-scoped guest (an outside reviewer, 0025) must not
  // see it. Require a FULL workspace membership (owner/admin/member).
  const { data: membership } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("workspace_id", deck.workspace_id)
    .maybeSingle();
  const role = membership?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") notFound();

  const { data: slides } = await supabase
    .from("canvas_deck_slide")
    .select("id, position, title")
    .eq("deck_id", id)
    .order("position", { ascending: true });
  const slideTitles = new Map<number, string>(
    (slides ?? []).map((s) => [s.position as number, (s.title as string) || ""]),
  );

  const admin = createAdminClient();
  const rows: PublicViewRow[] = [];
  let reachedEnd = false;
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data: page, error } = await admin
      .from("canvas_usage_event")
      .select("event, created_at, slide_id, duration_ms, props")
      .eq("deck_id", id)
      .eq("surface", "public")
      .in("event", [VIEW_EVENT_OPEN, VIEW_EVENT_SLIDE])
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("[engagement]", error);
      break;
    }
    rows.push(...((page ?? []) as PublicViewRow[]));
    if (!page || page.length < PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
  }
  // Broke on a query error, or ran out the MAX_ROWS cap before the final short
  // page — either way the aggregates below are computed from a truncated set,
  // so they must be flagged as a partial sample rather than shown as exact.
  const partial = !reachedEnd;

  const engagement = aggregateEngagement(rows, slides?.length ?? 0);
  const linkEnabled = Boolean(deck.public_share_token);
  const hasData = engagement.opens > 0 || engagement.uniqueSessions > 0;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <Link
          href={`/canvases/${id}`}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          Back to deck
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Engagement</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What recipients of the public link did with{" "}
          <strong className="font-medium text-foreground">{deck.title}</strong>.
          Anonymous, per-session view telemetry — directional, not exact.
        </p>
      </div>

      {partial ? (
        <p className="rounded-[10px] border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Showing a partial sample — some view events couldn’t be loaded, so
          these numbers may undercount.
        </p>
      ) : null}

      {!hasData ? (
        <EmptyState linkEnabled={linkEnabled} deckId={id} />
      ) : (
        <>
          <StatRow engagement={engagement} />
          <DropOffCard engagement={engagement} slideTitles={slideTitles} />
          <DwellCard engagement={engagement} slideTitles={slideTitles} />
        </>
      )}
    </main>
  );
}

function EmptyState({
  linkEnabled,
  deckId,
}: {
  linkEnabled: boolean;
  deckId: string;
}) {
  return (
    <section className="rounded-[12px] border border-border bg-card p-6">
      <div className="eyebrow">No opens yet</div>
      <p className="mt-2 text-sm text-muted-foreground">
        {linkEnabled ? (
          <>
            The public link is on, but nobody has opened it yet. Once someone
            views the deck, their opens, reading time, and drop-off show up
            here.
          </>
        ) : (
          <>
            This deck has no public link. Turn on link sharing from{" "}
            <Link
              href={`/canvases/${deckId}`}
              className="font-medium text-foreground underline underline-offset-2"
            >
              the deck&apos;s Share dialog
            </Link>{" "}
            and send it — engagement shows up here once someone opens it.
          </>
        )}
      </p>
    </section>
  );
}

function formatViewTime(ms: number): string {
  if (ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function StatRow({ engagement }: { engagement: DeckEngagement }) {
  const tiles = [
    { label: "Opens", value: String(engagement.opens) },
    { label: "Unique viewers", value: String(engagement.uniqueSessions) },
    {
      label: "Median view time",
      value: formatViewTime(engagement.medianViewMs),
    },
    {
      label: "Last opened",
      value: engagement.lastOpenedAt ? relativeDate(engagement.lastOpenedAt) : "—",
    },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-[12px] border border-border bg-card p-4">
          <div className="font-machine text-[11px] uppercase tracking-wide text-muted-foreground">
            {t.label}
          </div>
          <div className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">
            {t.value}
          </div>
        </div>
      ))}
    </section>
  );
}

// Slide-by-slide bar list. Single series, so the bars carry one hue (the
// app accent) and every row is direct-labeled in text tokens — this is a
// table with bars, not a legend-bearing chart.
function BarRow({
  index,
  title,
  valueLabel,
  share,
}: {
  index: number;
  title: string;
  valueLabel: string;
  share: number; // 0..1 of the row's bar track
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-machine w-6 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <span className="w-36 shrink-0 truncate text-xs text-muted-foreground sm:w-44">
        {title || "Untitled slide"}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[color:var(--accent)]"
          style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-foreground">
        {valueLabel}
      </span>
    </div>
  );
}

function DropOffCard({
  engagement,
  slideTitles,
}: {
  engagement: DeckEngagement;
  slideTitles: Map<number, string>;
}) {
  return (
    <section className="space-y-4 rounded-[12px] border border-border bg-card p-6">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Reader journey</div>
        <div className="text-xs text-muted-foreground">
          share of viewers reaching each slide
        </div>
      </div>
      <div className="space-y-2">
        {engagement.dropOff.map((point) => (
          <BarRow
            key={point.position}
            index={point.position}
            title={slideTitles.get(point.position) ?? ""}
            valueLabel={`${Math.round(point.share * 100)}%`}
            share={point.share}
          />
        ))}
      </div>
    </section>
  );
}

function DwellCard({
  engagement,
  slideTitles,
}: {
  engagement: DeckEngagement;
  slideTitles: Map<number, string>;
}) {
  const maxDwell = Math.max(1, ...engagement.perSlide.map((s) => s.avgDwellMs));
  return (
    <section className="space-y-4 rounded-[12px] border border-border bg-card p-6">
      <div className="flex items-baseline justify-between">
        <div className="eyebrow">Time per slide</div>
        <div className="text-xs text-muted-foreground">
          average across viewers who saw it
        </div>
      </div>
      <div className="space-y-2">
        {engagement.perSlide.map((slide) => (
          <BarRow
            key={slide.position}
            index={slide.position}
            title={slideTitles.get(slide.position) ?? ""}
            valueLabel={slide.avgDwellMs > 0 ? formatViewTime(slide.avgDwellMs) : "—"}
            share={slide.avgDwellMs / maxDwell}
          />
        ))}
      </div>
    </section>
  );
}
