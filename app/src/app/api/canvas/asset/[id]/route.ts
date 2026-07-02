// GET /api/canvas/asset/{id} — phase 1.
//
// Streams an extracted deck asset (typically a base64-decoded <img>) from the
// `decks` storage bucket. The canvas_deck_asset row is RLS-gated by workspace
// membership; once that select succeeds we use the service-role storage client
// to fetch the bytes (the workspace check has already passed). This avoids
// having to mirror RLS into storage policies for the read path.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyAssetSig } from "@/lib/canvas/asset-sign";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return new NextResponse("Bad asset id", { status: 400 });
  }

  // Two auth paths:
  //  - Signed URL (?exp&sig): emitted by the preview route after it passed RLS
  //    for the deck. Lets the sandboxed (opaque-origin) preview iframe load
  //    images without the cookie. Row is fetched via the admin client because
  //    the signature itself is the authorization.
  //  - Cookie + RLS: direct access (e.g. the editor, export). The RLS select on
  //    canvas_deck_asset enforces deck visibility.
  const exp = request.nextUrl.searchParams.get("exp");
  const sig = request.nextUrl.searchParams.get("sig");
  const signed = verifyAssetSig(id, exp, sig, Date.now());

  let asset: { storage_path: string | null; mime_type: string | null } | null;

  if (signed) {
    const admin = createAdminClient();
    const { data, error: assetErr } = await admin
      .from("canvas_deck_asset")
      .select("storage_path, mime_type")
      .eq("id", id)
      .maybeSingle();
    if (assetErr) {
      console.error("[asset]", assetErr);
      return new NextResponse("Asset lookup failed", { status: 500 });
    }
    asset = data;
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    const { data, error: assetErr } = await supabase
      .from("canvas_deck_asset")
      .select("storage_path, mime_type")
      .eq("id", id)
      .maybeSingle();
    if (assetErr) {
      console.error("[asset]", assetErr);
      return new NextResponse("Asset lookup failed", { status: 500 });
    }
    asset = data;
  }

  if (!asset?.storage_path) {
    // Either the row doesn't exist or RLS filtered it — treat both as 404.
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();
  const { data: blob, error: dlErr } = await admin.storage
    .from("decks")
    .download(asset.storage_path);

  if (dlErr || !blob) {
    console.error("[asset:download]", dlErr);
    return new NextResponse("Storage fetch failed", { status: 502 });
  }

  // SECURITY: assets are served from the app origin, so an attacker-controlled
  // active type (image/svg+xml can carry inline <script>, text/html is markup)
  // would be a stored-XSS sink if a user navigated directly to the asset URL.
  // Only hand back a browser-rendered Content-Type for known-inert raster/font
  // types; anything else is forced to download as an opaque blob. `nosniff`
  // stops the browser from second-guessing the declared type.
  const declared = (asset.mime_type || "").toLowerCase();
  const inlineSafe =
    declared.startsWith("image/") && declared !== "image/svg+xml"
      ? declared
      : /^font\/|^application\/(font-woff2?|x-font-)/.test(declared)
        ? declared
        : null;

  const headers: Record<string, string> = {
    "Content-Type": inlineSafe || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    // Per-deck assets are immutable (rewriting an image creates a new asset
    // row + URL). Aggressive caching is safe.
    "Cache-Control": "private, max-age=31536000, immutable",
  };
  if (!inlineSafe) headers["Content-Disposition"] = "attachment";

  return new NextResponse(blob, { status: 200, headers });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
