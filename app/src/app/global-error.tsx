"use client";

// Root error boundary. `error.tsx` only catches errors in the page subtree
// *below* the root layout; a throw in the root layout itself (fonts, the theme
// boot script, a top-level provider) escapes it and shows Next's default crash
// page. `global-error.tsx` is the last line of defense and must render its own
// <html>/<body>. Kept dependency-free and inline-styled so it works even if the
// app's CSS/runtime is what failed.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          // Dynamic viewport unit so the centered crash card isn't pushed below
          // the fold by mobile Safari's URL bar (100vh > visible viewport).
          minHeight: "100dvh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0a0a0f",
          color: "#e7e7ea",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem", maxWidth: 420 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: 8, fontSize: 14, color: "#a1a1aa" }}>
            An unexpected error occurred. Try again, or reload the page.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 20,
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #2a2a35",
              background: "#e7e7ea",
              color: "#0a0a0f",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p
              style={{
                marginTop: 16,
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                color: "#6b6b76",
              }}
            >
              {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
