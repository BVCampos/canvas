"use client";

import { useState } from "react";
import type { ActivityEvent, ActivityTone } from "@/lib/canvas/activity";

// The deck's activity feed — "who did what", newest first. Events arrive
// fully formed from the server (names resolved, sentences composed, dates
// formatted in buildDeckActivity + the page RSC); this component only
// renders and handles the show-more toggle.

const INITIAL_COUNT = 25;

export type ActivityFeedEvent = ActivityEvent & {
  at_formatted: string;
  at_relative: string;
};

// One accent dot per event family so the feed scans by color: green for
// things appearing, red for things disappearing, amber for open proposals,
// neutral for the rest.
const TONE_DOT: Record<ActivityTone, string> = {
  create: "bg-emerald-500",
  add: "bg-emerald-500",
  edit: "bg-sky-500",
  reorder: "bg-sky-500",
  restore: "bg-violet-500",
  snapshot: "bg-slate-400",
  comment: "bg-slate-400",
  delete: "bg-red-500",
  reject: "bg-red-400",
  pending: "bg-amber-500",
};

export function ActivityFeed({
  events,
  failedSources = [],
}: {
  events: ActivityFeedEvent[];
  // Feed sources whose query failed server-side (see the page RSC). An audit
  // feed must not pass a partial timeline off as the full story, so any
  // failure renders a visible warning instead of degrading silently.
  failedSources?: string[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, INITIAL_COUNT);

  return (
    <section className="rounded-[12px] border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <div className="eyebrow text-muted-foreground">Activity</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Everything that happened in this deck — newest first.
        </p>
      </div>

      {failedSources.length > 0 ? (
        <div className="border-b border-border bg-amber-50 px-5 py-2 text-xs text-amber-700">
          Activity may be incomplete — failed to load: {failedSources.join(", ")}.
          Try reloading the page.
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground">
          No activity yet.
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {visible.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                <span
                  aria-hidden
                  className={`mt-[7px] size-2 shrink-0 rounded-full ${TONE_DOT[e.tone]}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    <span className="font-semibold">{e.actor}</span> {e.text}
                    {e.viaClaude ? (
                      <span className="ml-2 rounded-full border border-border px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                        via agent
                      </span>
                    ) : null}
                    {e.pending ? (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-[0.06em] text-amber-700">
                        pending
                      </span>
                    ) : null}
                  </p>
                  {e.meta ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{e.meta}</p>
                  ) : null}
                </div>
                <time
                  dateTime={e.at}
                  title={e.at_formatted}
                  className="mt-0.5 shrink-0 text-[11px] text-muted-foreground"
                >
                  {e.at_relative}
                </time>
              </li>
            ))}
          </ul>
          {events.length > INITIAL_COUNT ? (
            <div className="border-t border-border px-5 py-3">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-xs font-medium text-[color:var(--accent)] hover:underline"
              >
                {showAll
                  ? "Show less"
                  : `Show all ${events.length} events`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
