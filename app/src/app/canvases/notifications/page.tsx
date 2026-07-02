import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { displayName } from "@/lib/utils";
import type { NotificationKind } from "@/lib/canvas/notifications";
import { NotificationFeed, type NotificationFeedRow } from "./notification-feed";

// /canvases/notifications
//
// Per-user in-app notification feed: collaboration messages and proposal
// lifecycle updates, newest first. RLS scopes canvas_notification to the
// caller's own rows, so the bare SELECT is already personal. Each row links
// into the deck (and slide, when set) so a click lands on the relevant comment;
// rows mark themselves read on click, and "Mark all read" clears the rest.
//
// Mirrors the inbox's shape: a thin server loader that batches the lookups
// (actor names, deck titles, slide positions) and hands an enriched list to a
// small client component for the interactive read state.

type RawNotificationRow = {
  id: string;
  kind: string;
  actor_id: string | null;
  deck_id: string | null;
  slide_id: string | null;
  comment_id: string | null;
  edit_id: string | null;
  body_preview: string | null;
  read_at: string | null;
  created_at: string;
};

function asKind(value: string): NotificationKind {
  switch (value) {
    case "comment_reply":
    case "proposal_waiting":
    case "proposal_applied":
    case "proposal_rejected":
    case "client_comment":
      return value;
    default:
      return "mention";
  }
}

export default async function NotificationsPage() {
  // Resolve auth (redirects if signed-out). The feed itself is workspace-
  // agnostic — RLS scopes to the user — but going through getActiveWorkspace
  // keeps the topbar's active-workspace selection consistent with the rest of
  // /canvases.
  await getActiveWorkspace("/canvases/notifications");
  const supabase = await createClient();

  const { data: rawRows } = await supabase
    .from("canvas_notification")
    .select(
      "id, kind, actor_id, deck_id, slide_id, comment_id, edit_id, body_preview, read_at, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  const rows: RawNotificationRow[] = rawRows ?? [];

  // Batch the lookups so we don't N+1: actor display names + deck titles +
  // slide positions. All RLS-gated; a deck the user can no longer read just
  // renders without a title link.
  const actorIds = Array.from(
    new Set(rows.map((r) => r.actor_id).filter((v): v is string => Boolean(v))),
  );
  const deckIds = Array.from(
    new Set(rows.map((r) => r.deck_id).filter((v): v is string => Boolean(v))),
  );
  const slideIds = Array.from(
    new Set(rows.map((r) => r.slide_id).filter((v): v is string => Boolean(v))),
  );

  const [actors, decks, slides] = await Promise.all([
    actorIds.length
      ? supabase.from("users").select("id, email, name").in("id", actorIds)
      : Promise.resolve({
          data: [] as { id: string; email: string | null; name: string | null }[],
        }),
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
  ]);

  const actorById = new Map(
    (actors.data ?? []).map((u) => [
      u.id,
      displayName({ email: u.email ?? "", name: u.name ?? null }),
    ]),
  );
  const deckTitleById = new Map((decks.data ?? []).map((d) => [d.id, d.title]));
  const slideById = new Map(
    (slides.data ?? []).map((s) => [s.id, { position: s.position, title: s.title }]),
  );

  const feedRows: NotificationFeedRow[] = rows.map((r) => {
    const slideInfo = r.slide_id ? slideById.get(r.slide_id) : null;
    return {
      id: r.id,
      kind: asKind(r.kind),
      actorName: r.actor_id ? actorById.get(r.actor_id) ?? null : null,
      deckId: r.deck_id,
      deckTitle: r.deck_id ? deckTitleById.get(r.deck_id) ?? null : null,
      slideId: r.slide_id,
      slidePosition: slideInfo?.position ?? null,
      slideTitle: slideInfo?.title ?? null,
      commentId: r.comment_id,
      editId: r.edit_id,
      bodyPreview: r.body_preview,
      readAt: r.read_at,
      createdAt: r.created_at,
    };
  });

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Mentions, replies, and proposal decisions show up
            here.
          </p>
        </div>
      </div>

      <NotificationFeed rows={feedRows} />
    </main>
  );
}
