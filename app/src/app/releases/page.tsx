import type { Metadata } from "next";
import {
  GITHUB_REPO_URL,
  RELEASES,
  type ReleaseTag,
} from "@/lib/canvas/release-notes";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Release notes",
};

// /releases — everything that shipped, newest first. Pure static render over
// the hand-curated list in lib/canvas/release-notes.ts.

const TAG_LABEL: Record<ReleaseTag, string> = {
  feature: "New",
  improvement: "Improved",
  fix: "Fixed",
  infra: "Infra",
};

// Chip palette follows the app's semantic color rules: blue (accent) for new
// human-facing capability, green (success) for fixed, neutrals for the rest.
const TAG_CLASS: Record<ReleaseTag, string> = {
  feature: "bg-brand-wash text-brand-dim",
  improvement: "bg-fog text-slate",
  fix: "bg-success/10 text-success-fg",
  infra: "bg-fog text-steel",
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(isoDate: string) {
  return DATE_FORMAT.format(new Date(`${isoDate}T00:00:00Z`));
}

export default function ReleasesPage() {
  return (
    <div>
      <header>
        <h1 className="text-xl font-semibold text-foreground">Release notes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything that shipped in Canvas, newest first.
        </p>
      </header>

      <ol className="mt-8">
        {RELEASES.map((release, index) => (
          <li key={release.date} className="relative flex gap-4 sm:gap-6">
            {/* Timeline rail: a dot per release, a line connecting them.
                The line is omitted on the last entry so the rail ends at
                the final dot instead of running into the page bottom. */}
            <div className="flex w-3 shrink-0 flex-col items-center" aria-hidden>
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  index === 0 ? "bg-brand" : "bg-silver",
                )}
              />
              {index < RELEASES.length - 1 && (
                <span className="w-px flex-1 bg-border" />
              )}
            </div>

            <section className="min-w-0 flex-1 pb-10">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h2 className="text-[15px] font-semibold text-foreground">
                  {release.title}
                </h2>
                <time
                  dateTime={release.date}
                  className="text-xs text-muted-foreground"
                >
                  {formatDate(release.date)}
                </time>
              </div>

              {/* Grid, not a single column: the layout is full-width, so wide
                  viewports fill the space with 2–3 columns of item cards. */}
              <ul className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {release.items.map((item) => (
                  <li
                    key={item.title}
                    className="rounded-lg border border-border bg-card px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          TAG_CLASS[item.tag],
                        )}
                      >
                        {TAG_LABEL[item.tag]}
                      </span>
                      <h3 className="text-[13px] font-medium text-foreground">
                        {item.title}
                      </h3>
                      {item.prs?.map((pr) => (
                        <a
                          key={pr}
                          href={`${GITHUB_REPO_URL}/pull/${pr}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          #{pr}
                        </a>
                      ))}
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          </li>
        ))}
      </ol>
    </div>
  );
}
