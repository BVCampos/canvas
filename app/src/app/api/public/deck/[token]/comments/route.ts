// GET /api/public/deck/{token}/comments — the threads a link visitor may see.
//
// TWO partitions guard this route:
//
//   1. The STRUCTURAL partition (the security property): a public visitor
//      sees ONLY client-rooted threads — comments that came in through the
//      public link — plus the team's replies to those. Internal member↔member
//      deliberation and Claude-proposal threads live in the same
//      canvas_comment table and must NEVER cross this boundary. Enforced by
//      selection: roots are author_kind='client', replies are parent_id IN
//      (those roots). No other rows can be reached.
//
//   2. The PER-GUEST partition (privacy, not authz): one link is often sent
//      to several recipients. Each browser mints an opaque client_session
//      key (0069) and passes it as ?session=; roots are additionally filtered
//      by client_session = <that key>, so a guest reads only their OWN
//      threads and never another recipient's name or feedback. The key is
//      forgeable — this is privacy-by-default between anonymous readers, not
//      a security boundary. A missing/invalid session, or a NULL-session row,
//      matches nobody: the safe empty result.
//
// Reply authors are resolved to a display NAME only (never an email) — a
// public surface must not enumerate workspace identities.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { trustedClientIp } from "@/lib/canvas/client-ip";
import type { PublicCommentThread } from "@/lib/canvas/public-comment-types";
// The opaque-session shape — one source, shared with the track/write routes.
import { SESSION_RE } from "@/lib/canvas/engagement";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const sessionParam = new URL(request.url).searchParams.get("session");
  const session =
    sessionParam && SESSION_RE.test(sessionParam) ? sessionParam : null;

  const admin = createAdminClient();

  const ip = trustedClientIp(request.headers);
  const perClient = ip
    ? await rateLimitOk(admin, `public-comments:ip:${ip}`, 60, 60, "closed")
    : true;
  const perToken = await rateLimitOk(admin, `public-comments:tok:${token}`, 600, 60, "closed");
  if (!perClient || !perToken) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const { data: deck, error: deckErr } = await admin
    .from("canvas_deck")
    .select("id, public_comments_enabled")
    .eq("public_share_token", token)
    .maybeSingle();
  if (deckErr) {
    console.error("[public-comments]", deckErr);
    return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
  }
  if (!deck || deck.public_comments_enabled !== true) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Without a usable session key there is no client thread to scope to this
  // reader — return the safe empty result rather than every guest's feedback.
  if (!session) {
    return NextResponse.json(
      { ok: true, threads: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Roots: this guest's client comments only. author_kind='client' is the
  // structural partition (no internal thread can be reached); client_session
  // is the per-guest partition (no other recipient's thread can be reached).
  const { data: roots, error: rootsErr } = await admin
    .from("canvas_comment")
    .select("id, slide_id, author_name, body, resolved, created_at")
    .eq("deck_id", deck.id)
    .eq("author_kind", "client")
    .eq("client_session", session)
    .is("parent_id", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (rootsErr) {
    console.error("[public-comments:roots]", rootsErr);
    return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
  }

  const rootIds = (roots ?? []).map((r) => r.id as string);
  type ReplyRow = {
    id: string;
    parent_id: string;
    author_kind: string;
    author_id: string | null;
    author_name: string | null;
    body: string;
    created_at: string;
  };
  let replies: ReplyRow[] = [];
  if (rootIds.length > 0) {
    const { data: replyRows, error: repliesErr } = await admin
      .from("canvas_comment")
      .select("id, parent_id, author_kind, author_id, author_name, body, created_at")
      .in("parent_id", rootIds)
      .order("created_at", { ascending: true })
      .limit(500);
    if (repliesErr) {
      console.error("[public-comments:replies]", repliesErr);
      return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
    }
    replies = (replyRows ?? []) as ReplyRow[];
  }

  // Resolve member reply authors to first names only.
  const memberIds = [
    ...new Set(replies.map((r) => r.author_id).filter((v): v is string => v != null)),
  ];
  const nameById = new Map<string, string>();
  if (memberIds.length > 0) {
    const { data: profiles } = await admin
      .from("users")
      .select("id, name")
      .in("id", memberIds);
    for (const p of profiles ?? []) {
      const first = ((p.name as string | null) ?? "").trim().split(/\s+/)[0];
      if (first) nameById.set(p.id as string, first);
    }
  }

  const replyAuthor = (r: ReplyRow): string => {
    if (r.author_kind === "client") return r.author_name ?? "Guest";
    if (r.author_kind === "claude") return "Agent";
    return (r.author_id ? nameById.get(r.author_id) : null) ?? "The team";
  };

  const threads: PublicCommentThread[] = (roots ?? []).map((root) => ({
    id: root.id as string,
    slide_id: (root.slide_id as string | null) ?? null,
    author: (root.author_name as string | null) ?? "Guest",
    body: root.body as string,
    resolved: root.resolved === true,
    created_at: root.created_at as string,
    replies: replies
      .filter((r) => r.parent_id === root.id)
      .map((r) => ({
        id: r.id,
        author: replyAuthor(r),
        body: r.body,
        created_at: r.created_at,
      })),
  }));

  return NextResponse.json(
    { ok: true, threads },
    { headers: { "Cache-Control": "no-store" } },
  );
}
