import Link from "next/link";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { relativeDate } from "@/lib/utils";
import { partitionDecksForView } from "@/lib/canvas/deck-list-view";
import { DeckRowMenu } from "./deck-row-menu";
import { DeckThumbnail } from "./deck-thumbnail";
import {
  NewProjectButton,
  ProjectRowActions,
  ProjectShareButton,
  type ProjectOption,
} from "./project-controls";

type DeckRowData = {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  updated_at: string;
  created_at: string;
  visibility: string | null;
  created_by: string | null;
  project_id: string | null;
  // Nullable archive marker (migration 0074): null = active, a timestamp =
  // archived (and when). Archived decks are split out of the default list.
  archived_at: string | null;
};

type FirstSlideRow = { id: string; deck_id: string };

// /canvases — deck index. Lists every deck the active workspace has access to,
// grouped by Project (a named deck group — e.g. one client proposal) with
// ungrouped decks last, newest first inside each group. Each row shows a
// pending-proposal count badge — the one signal that demands a decision —
// and a single ⋯ menu (deck-row-menu.tsx) holding Present / move / share /
// delete. Empty state nudges to /canvases/new.
export default async function CanvasesIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; archived?: string }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const statusFilter = ["draft", "in_review", "final"].includes(params.status ?? "")
    ? params.status ?? ""
    : "";
  // Which shelf we're looking at. Default (absent) = active decks; `?archived=1`
  // = the archived view. A deck is archived iff canvas_deck.archived_at is set;
  // archiving hides it from the active list without touching access (0074).
  const viewingArchived = params.archived === "1";
  const supabase = await createClient();
  // Active workspace + role (cached from the layout call — no extra round
  // trip). Guests are deck-scoped outside reviewers: they only ever see decks
  // shared with them and can't create decks or projects, so the New-deck /
  // New-project / first-run affordances are noise.
  const { workspace, role } = await getActiveWorkspace("/canvases");
  const isGuest = role === "guest";
  // Mirrors the canvas_deck DELETE policy: admins/owners delete any deck,
  // everyone else only the decks they created. Used to gate the per-row delete
  // affordance below — the server re-enforces this regardless. Moving a deck
  // between projects is a deck UPDATE, which follows the same shape.
  const isWorkspaceAdmin = role === "owner" || role === "admin";

  // Fetch decks + projects + pending counts + user in parallel. Every query is
  // scoped to the ACTIVE workspace (workspace.id) — RLS still gates what's
  // readable within it, but the index page must show one workspace's decks, not
  // the union across every workspace the user belongs to. Without this filter a
  // brand-new (empty) workspace surfaces every deck the user can read anywhere,
  // which reads as "decks from other stuff" leaking in. This mirrors the MCP
  // list_decks tool and the project query below, both already workspace-scoped.
  // The pending query returns one row per pending edit; we group by deck_id
  // client-side. The user id is forwarded to ShareDeckDialog so it can self-mark
  // and disable self-removal from a deck.
  const [decksResp, projectsResp, pendingResp, firstSlidesResp, userResp] = await Promise.all([
    supabase
      .from("canvas_deck")
      .select(
        "id, workspace_id, title, status, updated_at, created_at, visibility, created_by, project_id, archived_at",
      )
      .eq("workspace_id", workspace.id)
      .order("updated_at", { ascending: false }),
    // Projects, like decks, are scoped to the ACTIVE workspace — so the grouping
    // headers and the move/new-deck pickers only ever offer projects that the
    // active workspace's actions can actually use.
    supabase
      .from("canvas_project")
      .select("id, name, created_by")
      .eq("workspace_id", workspace.id)
      .order("name", { ascending: true }),
    // Pending-edit counts feed the per-deck badges and the header total; scope
    // them to the active workspace too (uses the (workspace_id, status) index)
    // so the header count can't be inflated by other workspaces' proposals.
    supabase
      .from("canvas_deck_edit")
      .select("deck_id")
      .eq("workspace_id", workspace.id)
      .eq("status", "pending"),
    supabase
      .from("canvas_deck_slide")
      .select("id, deck_id")
      .eq("workspace_id", workspace.id)
      .eq("position", 0),
    supabase.auth.getUser(),
  ]);
  const currentUserId = userResp.data.user?.id ?? null;

  if (decksResp.error) {
    console.error("[/canvases]", decksResp.error);
  }
  if (projectsResp.error) {
    console.error("[/canvases] projects", projectsResp.error);
  }

  const allItems: DeckRowData[] = (decksResp.data as DeckRowData[] | null) ?? [];
  const normalizedQuery = query.toLocaleLowerCase();
  const items = allItems.filter(
    (deck) =>
      (!normalizedQuery || deck.title.toLocaleLowerCase().includes(normalizedQuery)) &&
      (!statusFilter || deck.status === statusFilter),
  );
  // Active vs. archived split (0074) — pure view-model in deck-list-view.ts.
  // The active list keeps the project grouping below; archived decks render as
  // a flat shelf, most-recently-archived first. The tab count keys off the
  // UNFILTERED set so it doesn't shrink while you type; the toggle only appears
  // once something's archived (or you're on it), so a workspace that never
  // archives sees no extra chrome.
  const { activeItems, archivedItems, totalArchived, showArchivedTab } =
    partitionDecksForView(items, allItems, viewingArchived);
  // Toggle hrefs preserve the active search + status filter; only the archived
  // flag differs between the two.
  const viewParams = new URLSearchParams();
  if (query) viewParams.set("q", query);
  if (statusFilter) viewParams.set("status", statusFilter);
  const activeViewHref = `/canvases${viewParams.toString() ? `?${viewParams}` : ""}`;
  const archivedViewParams = new URLSearchParams(viewParams);
  archivedViewParams.set("archived", "1");
  const archivedViewHref = `/canvases?${archivedViewParams}`;
  const projects = projectsResp.data ?? [];
  const firstSlideByDeck = new Map(
    ((firstSlidesResp.data as FirstSlideRow[] | null) ?? []).map((slide) => [
      slide.deck_id,
      slide.id,
    ]),
  );
  const pendingByDeck = new Map<string, number>();
  for (const row of pendingResp.data ?? []) {
    pendingByDeck.set(row.deck_id, (pendingByDeck.get(row.deck_id) ?? 0) + 1);
  }
  const totalPending = pendingResp.data?.length ?? 0;

  // Group decks under their project; decks with no project (or a project the
  // user can't see — e.g. a guest's shared deck) fall into the ungrouped tail.
  const projectIds = new Set(projects.map((p) => p.id));
  const decksByProject = new Map<string, DeckRowData[]>();
  const ungrouped: DeckRowData[] = [];
  for (const deck of activeItems) {
    if (deck.project_id && projectIds.has(deck.project_id)) {
      const list = decksByProject.get(deck.project_id) ?? [];
      list.push(deck);
      decksByProject.set(deck.project_id, list);
    } else {
      ungrouped.push(deck);
    }
  }

  // The move-to-project picker needs the plain option list.
  const projectOptions: ProjectOption[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
  }));

  function renderDeckRow(deck: DeckRowData) {
    const pending = pendingByDeck.get(deck.id) ?? 0;
    // Admins/owners can delete/move anything; members only their own decks.
    const canManageDeck = isWorkspaceAdmin || deck.created_by === currentUserId;
    // Self-describing from the row: an archived deck only ever shows in the
    // archived view, so the row derives its own state and hands it to the menu
    // (Archive ↔ Unarchive) without threading a view flag through.
    const isArchived = deck.archived_at != null;
    // Moving needs the deck to belong to the ACTIVE workspace (setDeckProject
    // rejects a cross-workspace move) and somewhere to move it to, or out of.
    // The list is already workspace-scoped, so this check is belt-and-suspenders
    // — it keeps the move guard correct even if the query filter ever changes.
    // Guests never qualify: they have no projects.
    const canMoveToProject =
      canManageDeck &&
      deck.workspace_id === workspace.id &&
      (projectOptions.length > 0 || deck.project_id !== null);
    return (
      // Stretched-link layout: the <Link> renders a pseudo-element
      // (`after:absolute after:inset-0`) that covers the whole <li>,
      // so clicking empty space, the badge, or the status text still
      // navigates — matching the pre-chip behaviour. The actions
      // cluster sits at `relative z-[1]` so its children (the chip
      // button) stack above the pseudo and stay independently
      // clickable. The `<li>` is `relative` to anchor the pseudo.
      <li
        key={deck.id}
        className="relative flex items-center gap-4 px-4 py-4 transition-colors hover:bg-[color:var(--accent-wash)] sm:px-5"
      >
        <DeckThumbnail
          src={
            firstSlideByDeck.get(deck.id)
              ? `/api/decks/${deck.id}/slides/${firstSlideByDeck.get(deck.id)}/thumbnail`
              : null
          }
        />
        <Link
          href={`/canvases/${deck.id}`}
          className="min-w-0 flex-1 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring after:absolute after:inset-0 after:content-['']"
        >
          <div className="truncate text-sm font-semibold text-foreground">
            {deck.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>Updated {relativeDate(deck.updated_at)}</span>
            <span aria-hidden>·</span>
            <span>{deck.status.replace("_", " ")}</span>
            {deck.visibility === "private" ? (
              <>
                <span aria-hidden>·</span>
                <span>Private</span>
              </>
            ) : null}
            {isArchived && deck.archived_at ? (
              <>
                <span aria-hidden>·</span>
                <span>Archived {relativeDate(deck.archived_at)}</span>
              </>
            ) : null}
          </div>
        </Link>
        {/* Right cluster is `pointer-events-none` so its background
            falls through to the Link's stretched ::after overlay. The ⋯
            menu trigger is the only element that re-enables pointer-events;
            the pending badge stays inert so clicking it still enters the
            deck. */}
        <div className="pointer-events-none relative flex shrink-0 items-center gap-3">
          {pending > 0 && (
            <span
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning-fg ring-1 ring-warning/40"
              aria-label={`${pending} pending proposal${pending === 1 ? "" : "s"}`}
              title={`${pending} pending proposal${pending === 1 ? "" : "s"}`}
            >
              {pending}
            </span>
          )}
          <DeckRowMenu
            deckId={deck.id}
            deckTitle={deck.title}
            canManageDeck={canManageDeck}
            canMoveToProject={canMoveToProject}
            currentProjectId={deck.project_id}
            projects={projectOptions}
            currentUserId={currentUserId}
            archived={isArchived}
          />
        </div>
      </li>
    );
  }

  function renderDeckList(decks: DeckRowData[]) {
    return (
      <ul className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-card">
        {decks.map(renderDeckRow)}
      </ul>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 space-y-6">
      {/* Stack the title above the action cluster on mobile so neither gets
          squeezed; revert to the side-by-side baseline-aligned row at sm+. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Decks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Multiplayer HTML decks built with any MCP-compatible agent.
          </p>
        </div>
        {/* Allow the buttons to wrap rather than overflow on the narrowest
            phones. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/canvases/inbox">
              Proposals
              {totalPending > 0 && (
                <span
                  className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning-fg ring-1 ring-warning/40"
                  aria-label={`${totalPending} pending`}
                >
                  {totalPending}
                </span>
              )}
            </Link>
          </Button>
          {!isGuest && <NewProjectButton workspaceId={workspace.id} />}
          {!isGuest && (
            <Button asChild>
              <Link href="/canvases/new">New deck</Link>
            </Button>
          )}
        </div>
      </div>

      {/* Active / Archived view switch. Appears only once something is on the
          shelf (or you're already viewing it), so it never adds chrome for a
          workspace that hasn't archived anything. Preserves the search + status
          filter across the switch. */}
      {showArchivedTab ? (
        <div className="flex items-center gap-1 text-sm">
          <Link
            href={activeViewHref}
            aria-current={!viewingArchived ? "page" : undefined}
            className={
              !viewingArchived
                ? "rounded-[8px] bg-[color:var(--accent-wash)] px-3 py-1.5 font-medium text-foreground"
                : "rounded-[8px] px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            Active
          </Link>
          <Link
            href={archivedViewHref}
            aria-current={viewingArchived ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 ${
              viewingArchived
                ? "bg-[color:var(--accent-wash)] font-medium text-foreground"
                : "text-muted-foreground transition-colors hover:text-foreground"
            }`}
          >
            Archived
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              {totalArchived}
            </span>
          </Link>
        </div>
      ) : null}

      {allItems.length > 0 ? (
        <form
          method="get"
          role="search"
          className="flex flex-col gap-2 rounded-[12px] border border-border bg-card p-3 sm:flex-row sm:items-center"
        >
          {/* A GET submit replaces the whole query string with the form fields,
              so without this the search would drop ?archived=1 and bounce you
              back to the Active view. Keep the shelf selected while searching. */}
          {viewingArchived ? (
            <input type="hidden" name="archived" value="1" />
          ) : null}
          <label htmlFor="deck-search" className="sr-only">
            Search decks
          </label>
          <input
            id="deck-search"
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search decks…"
            className="h-9 min-w-0 flex-1 rounded-[8px] border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <label htmlFor="deck-status-filter" className="sr-only">
            Filter by status
          </label>
          <select
            id="deck-status-filter"
            name="status"
            defaultValue={statusFilter}
            className="h-9 rounded-[8px] border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="in_review">In review</option>
            <option value="final">Final</option>
          </select>
          <Button type="submit" variant="outline">
            Find
          </Button>
          {query || statusFilter ? (
            <Button asChild variant="ghost">
              {/* Clear the filters (drop q/status) but stay on whichever shelf
                  you're viewing — a bare ?archived=1, not archivedViewHref
                  (which carries the very filters we're clearing). */}
              <Link href={viewingArchived ? "/canvases?archived=1" : "/canvases"}>Clear</Link>
            </Button>
          ) : null}
        </form>
      ) : null}

      {decksResp.error ? (
        <div className="rounded-[12px] border border-border bg-card p-12 text-center">
          <div className="eyebrow text-[color:var(--danger)]">Couldn&apos;t load decks</div>
          <h2 className="mt-3 text-lg font-semibold tracking-tight">
            Something went wrong
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            We couldn&apos;t load your decks just now. Refresh to try again — nothing
            has been lost.
          </p>
        </div>
      ) : allItems.length === 0 && projects.length === 0 ? (
        isGuest ? (
          <div className="rounded-[12px] border border-border bg-card p-12 text-center">
            <div className="eyebrow">Nothing shared yet</div>
            <h2 className="mt-3 text-lg font-semibold tracking-tight">
              No decks have been shared with you
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              You&rsquo;re here as an outside reviewer. When someone shares a
              deck with you, it&rsquo;ll appear here and open straight to that
              deck.
            </p>
          </div>
        ) : (
          <div className="rounded-[12px] border border-border bg-card p-12 text-center">
            <div className="eyebrow">No decks yet</div>
            <h2 className="mt-3 text-lg font-semibold tracking-tight">
              Import an HTML deck — or start blank
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Upload an existing agent-generated deck and Canvas decomposes it
              into editable slides — or start from a template and let your
              preferred agent draft it. Your team and their agents can work on
              different slides in parallel.
            </p>
            <Link
              href="/canvases/new"
              className="mt-4 inline-flex text-sm font-medium text-[color:var(--accent)] hover:underline"
            >
              Create your first deck →
            </Link>
          </div>
        )
      ) : viewingArchived ? (
        // Archived shelf — a flat list, most-recently-archived first. Empty
        // either because nothing's archived or the search/status filter hid it.
        archivedItems.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-border bg-card p-10 text-center">
            <h2 className="text-base font-semibold text-foreground">
              {query || statusFilter ? "No matching archived decks" : "No archived decks"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {query || statusFilter
                ? "Try a different title or clear the status filter."
                : "Decks you archive are shelved here, out of the active list."}
            </p>
            <Link
              href={activeViewHref}
              className="mt-3 inline-flex text-sm font-medium text-[color:var(--accent)] hover:underline"
            >
              ← Back to active decks
            </Link>
          </div>
        ) : (
          renderDeckList(archivedItems)
        )
      ) : activeItems.length === 0 && Boolean(query || statusFilter) ? (
        <div className="rounded-[12px] border border-dashed border-border bg-card p-10 text-center">
          <h2 className="text-base font-semibold text-foreground">No matching decks</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a different title or clear the status filter.
          </p>
          <Link
            href={activeViewHref}
            className="mt-3 inline-flex text-sm font-medium text-[color:var(--accent)] hover:underline"
          >
            Clear filters
          </Link>
        </div>
      ) : activeItems.length === 0 && totalArchived > 0 ? (
        // No active decks but some are archived — point at the shelf rather than
        // showing a wall of empty project placeholders. Gated on totalArchived
        // so a brand-new workspace with empty projects (nothing archived) still
        // falls through to the project-grouped "create a deck here" affordances.
        <div className="rounded-[12px] border border-dashed border-border bg-card p-10 text-center">
          <h2 className="text-base font-semibold text-foreground">No active decks</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every deck here is archived.
          </p>
          <Link
            href={archivedViewHref}
            className="mt-3 inline-flex text-sm font-medium text-[color:var(--accent)] hover:underline"
          >
            View archived ({totalArchived}) →
          </Link>
        </div>
      ) : projects.length === 0 ? (
        // No projects yet — keep the flat list this page has always shown.
        renderDeckList(ungrouped)
      ) : (
        <div className="space-y-8">
          {projects
            .filter(
              (project) =>
                (!query && !statusFilter) ||
                (decksByProject.get(project.id)?.length ?? 0) > 0,
            )
            .map((project) => {
            const decks = decksByProject.get(project.id) ?? [];
            const canManageProject =
              isWorkspaceAdmin || project.created_by === currentUserId;
            return (
              <section key={project.id} className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h2 className="truncate text-sm font-semibold tracking-tight">
                      {project.name}
                    </h2>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {decks.length} deck{decks.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!isGuest && (
                      <ProjectShareButton
                        projectId={project.id}
                        projectName={project.name}
                        currentUserId={currentUserId}
                      />
                    )}
                    {canManageProject && (
                      <ProjectRowActions
                        projectId={project.id}
                        projectName={project.name}
                      />
                    )}
                  </div>
                </div>
                {decks.length === 0 ? (
                  <div className="rounded-[12px] border border-dashed border-border bg-card px-5 py-6 text-sm text-muted-foreground">
                    No decks yet —{" "}
                    <Link
                      href={`/canvases/new?project=${project.id}`}
                      className="font-medium text-[color:var(--accent)] hover:underline"
                    >
                      create one in this project
                    </Link>{" "}
                    or move an existing deck here.
                  </div>
                ) : (
                  renderDeckList(decks)
                )}
              </section>
            );
          })}
          {ungrouped.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-baseline gap-2">
                <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">
                  No project
                </h2>
                <span className="text-xs text-muted-foreground">
                  {ungrouped.length} deck{ungrouped.length === 1 ? "" : "s"}
                </span>
              </div>
              {renderDeckList(ungrouped)}
            </section>
          )}
        </div>
      )}
    </main>
  );
}
