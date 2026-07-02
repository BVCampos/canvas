// Minimal seed HTML for a blank deck — a single near-empty cover slide
// ("NEW DECK" eyebrow + the title). Shared by the web importer route and the
// MCP `create_deck` tool so both greenfield paths produce identical decks and
// flow through the same parser. The empty-state CTA (set up MCP / open in
// Claude Code) is NOT baked in here — it lives as a live overlay on the deck
// view so it can react to the user's current token state without rewriting
// persisted slide HTML.

export function blankDeckHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --canvas-ink: #0e1a2b;
      --canvas-steel: #66788c;
      --canvas-accent: #3b82e0;
      --canvas-accent-dim: #1f5bb5;
      --canvas-paper: #ffffff;
      --canvas-fog: #ecf3fb;
    }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--canvas-ink);
      background: var(--canvas-fog);
      -webkit-font-smoothing: antialiased;
    }
    .deck { min-height: 100vh; display: flex; flex-direction: column; }
    .slides { flex: 1; }
    .slide {
      box-sizing: border-box;
      min-height: 100vh;
      padding: 64px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 20px;
      background: var(--canvas-paper);
    }
    .slide .eyebrow {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--canvas-steel);
      margin: 0;
    }
    .slide h1 {
      font-size: clamp(40px, 6vw, 72px);
      line-height: 1.05;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--canvas-ink);
      margin: 0;
      max-width: 16ch;
    }
  </style>
</head>
<body>
  <section class="slide cover">
    <p class="eyebrow">New deck</p>
    <h1>${escapeHtml(title)}</h1>
  </section>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
