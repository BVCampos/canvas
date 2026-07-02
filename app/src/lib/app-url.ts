// Canonical public origin of this Canvas instance.
//
// Self-hosted Next standalone (the EC2 + Cloudflare-Tunnel box, ADR-0004 infra)
// builds `request.url` / `new URL(request.url)` from a fixed `localhost:PORT`
// base — it ignores the incoming `Host` / `X-Forwarded-Host` headers, honouring
// only `x-forwarded-proto` for the scheme. So `NextResponse.redirect(new URL(
// path, request.url))` emits `https://localhost:3001/...` Location headers,
// which are a DIFFERENT origin than the page the browser loaded. The deck-import
// form POST then trips the app's `form-action 'self'` CSP on that cross-origin
// redirect (the reported "Create Deck blocked by CSP" bug); auth callbacks land
// on localhost too. On Vercel this never surfaced because the platform injected
// the real host into request.url.
//
// Fix: build user-facing absolute URLs from NEXT_PUBLIC_APP_URL (set per env —
// http://localhost:3001 in dev, https://canvas.21xventures.com in prod) instead
// of trusting request.url's host. Falls back to the request origin only when the
// env var is unset (keeps ad-hoc/local runs working).
export function appOrigin(req?: { url: string }): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  if (req) return new URL(req.url).origin;
  return "http://localhost:3001";
}
