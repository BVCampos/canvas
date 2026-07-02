"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

// Topbar unread-notification badge. Server-rendered with an initial count (the
// topbar's SELECT count), then kept live by a Realtime subscription on
// canvas_notification filtered to this user: a new mention/reply bumps the
// count, marking-read decrements it. RLS already scopes payloads to the user's
// own rows, but we also filter by user_id at the realtime layer to avoid
// waking on rows we'd never see.
//
// Rather than track exact deltas from each payload (insert => +1, update where
// read_at went non-null => -1), which is fiddly to get right across mark-all
// and concurrent tabs, we re-query the count on any change. It's a single cheap
// index-only count against the partial unread index (migration 0048) and keeps
// the badge correct without replicating the read-state logic client-side.

export function NotificationBell({
  userId,
  initialUnread,
}: {
  userId: string;
  initialUnread: number;
}) {
  // `liveUnread` is the count from a realtime recount; null until we've heard
  // from the channel. We DISPLAY the live count once we have one, else the
  // server-rendered `initialUnread`. This lets a server re-render (e.g. after a
  // router.refresh from marking-read) update the badge without mirroring the
  // prop into state via an effect (React 19's set-state-in-effect rule).
  const [liveUnread, setLiveUnread] = useState<number | null>(null);
  // When the server prop changes (a fresh render), trust it again — the recount
  // it reflects is at least as new as our last channel echo, and it's the value
  // the page was rendered with. Adjust-during-render is React's recommended way
  // to reset state on prop change without an effect.
  const [seenInitial, setSeenInitial] = useState(initialUnread);
  if (seenInitial !== initialUnread) {
    setSeenInitial(initialUnread);
    setLiveUnread(null);
  }
  const unread = liveUnread ?? initialUnread;

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();

    let alive = true;
    const recount = async () => {
      const { count, error } = await supabase
        .from("canvas_notification")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      if (!alive || error) return;
      setLiveUnread(count ?? 0);
    };

    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "canvas_notification",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void recount();
        },
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const label =
    unread > 0
      ? `Notifications, ${unread} unread`
      : "Notifications";

  return (
    <Link
      href="/canvases/notifications"
      className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[color:var(--accent-wash)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      title={label}
      aria-label={label}
    >
      <Bell className="h-[18px] w-[18px]" aria-hidden />
      {unread > 0 && (
        <span
          // Subtle accent count chip overlapping the bell's top-right. Caps at
          // 9+ so a noisy week doesn't blow out the topbar row.
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--accent)] px-1 text-[10px] font-semibold leading-none text-white"
          aria-hidden
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}
