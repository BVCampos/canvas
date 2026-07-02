import type { NextConfig } from "next";

// --- Security headers -------------------------------------------------------
//
// The app ingests arbitrary third-party HTML ("decks") and renders it in an
// iframe, so the transport layer carries real weight:
//
//  - App pages get a strict CSP that forbids being framed (clickjacking) and
//    pins connect/img/script sources. Inline `script`/`style` are still allowed
//    because Next's runtime bootstrap and the theme-boot script in layout.tsx
//    are inline; tightening these to a nonce is a tracked follow-up.
//  - The deck preview / asset / export API routes are deliberately EXCLUDED
//    from the app CSP (the `(?!api/)` matcher) — they serve untrusted deck HTML
//    into the editor's same-origin iframe and set their own sandbox CSP in the
//    route handlers, so inheriting `frame-ancestors 'none'` here would break
//    the editor's own preview frame.
//
// Supabase origins are derived from the public env var so this stays correct
// across local/preview/prod without hardcoding the project ref.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseWs = supabaseUrl.replace(/^https:/, "wss:");
const isProd = process.env.NODE_ENV === "production";

const appCsp = [
  "default-src 'self'",
  // Inline needed for Next's bootstrap + the theme-boot <script> (layout.tsx).
  "script-src 'self' 'unsafe-inline'",
  // Tailwind 4 + next/font inject inline <style>.
  "style-src 'self' 'unsafe-inline'",
  // Deck assets come from /api/canvas/asset (self); https: covers OAuth avatars.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseUrl} ${supabaseWs}`.trim(),
  // The editor frames the same-origin deck preview route.
  "frame-src 'self'",
  // No one may frame the app shell (clickjacking).
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const baseSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the EC2 host (AWS migration). `next build`
  // emits `.next/standalone/` with a minimal `server.js` + traced node_modules;
  // CI ships that (plus `.next/static` and `public`, which standalone does NOT
  // copy) as the deploy tarball, and the box just runs `node server.js`. No
  // toolchain or `npm ci` on the box. See app/infra/README.md.
  output: "standalone",
  // The PDF export route (src/app/api/decks/[id]/export/pdf) loads
  // @sparticuz/chromium, which resolves its brotli'd Chromium binary at
  // runtime relative to its own files. Letting webpack bundle the package
  // drops those binary assets from the lambda, so chromium.executablePath()
  // throws in prod (→ 500 "PDF render failed"). Externalizing keeps both
  // packages as plain node_modules requires so the binary ships intact.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // NOTE: we deliberately do NOT force-trace @sparticuz/chromium's 60MB brotli
  // binary into the bundle (the old `outputFileTracingIncludes` for the Lambda
  // path). The EC2 host renders PDFs with a system Chromium via CHROMIUM_PATH
  // (see export/pdf/route.ts + app/infra), so shipping the x86_64 Lambda binary
  // to the arm64 box was ~60MB of dead weight. @sparticuz stays external (its
  // small JS is still traced) so the Lambda branch remains buildable if ever
  // needed, but its binary is no longer bundled.
  experimental: {
    // Keep dynamic-route RSC payloads in the client router cache so that
    // back/forward and re-visits don't re-run server fetches. Matches the
    // pre-Next-15 default and avoids unnecessary server work on tab returns.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
  async headers() {
    return [
      // Baseline hardening on every response (safe for API routes too).
      { source: "/:path*", headers: baseSecurityHeaders },
      // Strict CSP + anti-framing on app pages only — NOT the /api/* content
      // routes that feed the editor's same-origin preview iframe.
      {
        source: "/((?!api/).*)",
        headers: [
          { key: "Content-Security-Policy", value: appCsp },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
