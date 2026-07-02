// POST /api/public/deck/{token}/comment — a link recipient leaves per-slide
// feedback without an account.
//
// The first TRULY unauthenticated write surface (MCP/import are cookieless
// but token-authenticated by a bearer secret; this one carries no credential
// at all), so the guardrails come first:
//   * per-deck opt-in (canvas_deck.public_comments_enabled, default OFF) —
//     no flag, no write path;
//   * TOKEN_RE before any DB hit; deck resolved by exact token match;
//   * fail-closed rate limits keyed on trusted IP AND share token;
//   * an API-replay tripwire: a "website" field the composer keeps hidden
//     from humans (aria-hidden, off-screen) and always posts empty — any
//     filled value is a form-scraping bot and gets a fake success;
//   * strict field validation and length caps.
//
// The insert goes through the service-role client (canvas_comment has no
// anon policies, deliberately) with author_kind='client', author_id=null,
// the client-typed name/email as unverified attribution (migration 0064),
// and an opaque client_session key (0069) that scopes which guest sees this
// thread back on the public read route — privacy between recipients of one
// link, never authorization. The route asserts the returned row — the
// resolveComment lesson: a public writer must never report success on a
// write that didn't land.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimitOk } from "@/lib/canvas/rate-limit";
import { trustedClientIp } from "@/lib/canvas/client-ip";
import { logUsage } from "@/lib/usage/log";
import { logNotifications } from "@/lib/notifications/log";
import { notificationsForClientComment } from "@/lib/canvas/notifications";
// The opaque-session shape — one source, shared with the track/read routes.
import { SESSION_RE } from "@/lib/canvas/engagement";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const MAX_NAME_LEN = 80;
const MAX_EMAIL_LEN = 120;
const MAX_BODY_LEN = 4000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const b = raw as Record<string, unknown>;

  // Honeypot: the composer renders a "website" field hidden from humans
  // (aria-hidden, off-screen, tab-skipped) and always posts it empty. A
  // filled value is a form-scraping bot or a replay; give it a fake success
  // so it moves on, and write nothing.
  if (typeof b.website === "string" && b.website.trim() !== "") {
    return NextResponse.json({ ok: true, id: null });
  }

  const name = typeof b.name === "string" ? b.name.trim().slice(0, MAX_NAME_LEN) : "";
  const email =
    typeof b.email === "string" && b.email.trim() !== ""
      ? b.email.trim().slice(0, MAX_EMAIL_LEN)
      : null;
  const body = typeof b.body === "string" ? b.body.trim() : "";
  const slideId =
    typeof b.slide_id === "string" && UUID_RE.test(b.slide_id) ? b.slide_id : null;
  // Opaque per-guest key so this thread comes back only to the recipient who
  // wrote it. Unverified and forgeable — a privacy partition, not authz. A
  // malformed value is dropped to null (scopes the thread to nobody), never a
  // hard error.
  const clientSession =
    typeof b.session === "string" && SESSION_RE.test(b.session) ? b.session : null;

  if (name === "" || body === "" || body.length > MAX_BODY_LEN) {
    return NextResponse.json({ ok: false, error: "invalid_fields" }, { status: 400 });
  }
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Tighter than the read routes: comments are the expensive rows.
  const ip = trustedClientIp(request.headers);
  const perClient = ip
    ? await rateLimitOk(admin, `public-comment:ip:${ip}`, 8, 60, "closed")
    : true;
  const perToken = await rateLimitOk(admin, `public-comment:tok:${token}`, 40, 60, "closed");
  if (!perClient || !perToken) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const { data: deck, error: deckErr } = await admin
    .from("canvas_deck")
    .select("id, workspace_id, created_by, public_comments_enabled")
    .eq("public_share_token", token)
    .maybeSingle();
  if (deckErr) {
    console.error("[public-comment]", deckErr);
    return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
  }
  // A deck without the link or without the opt-in looks identical from
  // outside: nothing here.
  if (!deck || deck.public_comments_enabled !== true) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (slideId !== null) {
    const { data: slide } = await admin
      .from("canvas_deck_slide")
      .select("id")
      .eq("id", slideId)
      .eq("deck_id", deck.id)
      .maybeSingle();
    if (!slide) {
      return NextResponse.json({ ok: false, error: "invalid_slide" }, { status: 400 });
    }
  }

  const { data: inserted, error: insertErr } = await admin
    .from("canvas_comment")
    .insert({
      workspace_id: deck.workspace_id,
      deck_id: deck.id,
      slide_id: slideId,
      parent_id: null,
      author_kind: "client",
      author_id: null,
      author_name: name,
      author_email: email,
      client_session: clientSession,
      body,
      mentions: [],
    })
    .select("id, created_at")
    .single();

  // Assert the row landed (service-role bypasses RLS, but constraint
  // violations and outages must surface as real failures, never a silent ok).
  if (insertErr || !inserted) {
    console.error("[public-comment:insert]", insertErr);
    logUsage({
      event: "public_comment.create",
      surface: "public",
      workspace_id: deck.workspace_id,
      deck_id: deck.id,
      slide_id: slideId,
      status: "error",
      error_code: insertErr?.code ?? "insert_error",
    });
    return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
  }

  // Notify the deck's people: the creator plus explicit deck members. A
  // client actor has no user_id, so recipients are resolved directly rather
  // than through the member codepath's actor exclusion.
  const { data: deckMembers } = await admin
    .from("canvas_deck_member")
    .select("user_id")
    .eq("deck_id", deck.id);
  const recipientIds = [
    ...(deck.created_by ? [deck.created_by as string] : []),
    ...(deckMembers ?? []).map((m) => m.user_id as string),
  ];
  logNotifications(
    notificationsForClientComment({
      workspaceId: deck.workspace_id as string,
      deckId: deck.id as string,
      slideId,
      commentId: inserted.id as string,
      authorName: name,
      body,
      recipientIds,
    }),
  );

  logUsage({
    event: "public_comment.create",
    surface: "public",
    workspace_id: deck.workspace_id,
    deck_id: deck.id,
    slide_id: slideId,
    status: "ok",
    props: { body_len: body.length, has_email: email !== null },
  });

  return NextResponse.json(
    {
      ok: true,
      comment: {
        id: inserted.id,
        slide_id: slideId,
        author: name,
        body,
        created_at: inserted.created_at,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
