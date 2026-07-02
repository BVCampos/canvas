import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Canvas",
  description:
    "Multiplayer HTML decks built with any MCP-compatible agent. Slide ownership, proposal diffs, and threaded comments.",
};

// Viewport is split from `metadata` per the Next 16 API. Three mobile-critical
// settings live here:
//   - width=device-width + initialScale 1: the standard responsive baseline.
//   - viewportFit="cover": lets the layout extend under the notch / home
//     indicator on modern phones, which is the prerequisite for the
//     `env(safe-area-inset-*)` padding utilities (see globals.css) used by the
//     bottom sheets and the present-mode control bar.
//   - themeColor: tints the mobile browser chrome to match the app surface in
//     each theme (fog in light, ink/navy in dark) so the status-bar area
//     blends with the topbar instead of flashing white.
// We deliberately DON'T set maximumScale / userScalable — pinch-zoom must stay
// available for accessibility.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f5fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1a2b" },
  ],
};

// Runs synchronously before paint so the `dark` class is on <html> before
// React hydrates — no flash of light content for users on dark mode. Mirrors
// the persisted choice in localStorage (key: canvas-theme = system|light|dark).
const themeBootScript = `(function(){try{var t=localStorage.getItem('canvas-theme')||'system';var dark=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);if(dark)document.documentElement.classList.add('dark');}catch(e){}})();`;

// suppressHydrationWarning on <html> below so React doesn't object when the
// boot script in <head> adds the `dark` class to <html> before hydration.
// Without it, the server's class string differs from the client's after the
// script runs, which React would otherwise log as a hydration warning.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-full antialiased app-shell">
        {/*
         * Skip-to-content link. Visible only when focused (keyboard tab
         * land), invisible to mouse users. Targets the wrapper id below so
         * screen-reader / keyboard users can jump past the sticky topbar
         * and primary nav landmarks. Anchored to the very top of the body
         * so it's the first focusable element in tab order. The button
         * styling uses the same `--ring` token as Button focus rings for
         * consistency.
         */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-[8px] focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[color:var(--ring)] focus:ring-offset-2 focus:ring-offset-background"
        >
          Skip to content
        </a>
        <div className="app-shell-atmosphere" aria-hidden />
        <div id="main-content" className="relative z-[1] min-h-full">
          {children}
        </div>
      </body>
    </html>
  );
}
