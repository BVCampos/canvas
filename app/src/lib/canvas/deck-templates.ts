// Starter deck templates for the New Deck flow.
//
// The only greenfield path used to be blankDeckHtml() — one near-empty cover
// slide. A first-time user picking "start blank" landed on a one-slide deck with
// nothing to react to. These templates give a real skeleton to edit instead, and
// (this is the point) they are just SOURCE HTML: each build() returns a full
// document that flows through the SAME parser/importer as an uploaded or pasted
// deck, so there is no second code path to keep in sync. The web form submits a
// template id; the import route resolves it here with the user's real title so
// the cover matches.

export type DeckTemplate = {
  id: string;
  name: string;
  description: string;
  build: (title: string) => string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared chrome. One theme (mirrors blank-deck's palette/type) wrapping an
// ordered list of <section class="slide"> bodies, so every template parses into
// the same slide shape the kit expects.
function doc(title: string, slides: string[]): string {
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
    .slide {
      box-sizing: border-box;
      min-height: 100vh;
      padding: 72px 88px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 18px;
      background: var(--canvas-paper);
    }
    .slide.cover { align-items: center; text-align: center; }
    .eyebrow {
      font-size: 11px; font-weight: 600; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--canvas-steel); margin: 0;
    }
    .slide h1 {
      font-size: clamp(40px, 6vw, 72px); line-height: 1.05; font-weight: 700;
      letter-spacing: -0.02em; margin: 0; max-width: 18ch;
    }
    .slide h2 {
      font-size: clamp(28px, 3.4vw, 40px); line-height: 1.1; font-weight: 700;
      letter-spacing: -0.01em; margin: 0;
    }
    .slide p.lead { font-size: 20px; line-height: 1.5; color: var(--canvas-steel); margin: 0; max-width: 60ch; }
    .slide ul { margin: 8px 0 0; padding-left: 22px; font-size: 20px; line-height: 1.7; }
    .slide ul li { margin-bottom: 6px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 8px; }
    .card { border: 1px solid var(--canvas-fog); border-radius: 12px; padding: 20px 22px; }
    .card h3 { margin: 0 0 6px; font-size: 18px; }
    .card p { margin: 0; color: var(--canvas-steel); font-size: 16px; line-height: 1.5; }
  </style>
</head>
<body>
${slides.map((s) => `  <section class="slide${s.startsWith("<!--cover-->") ? " cover" : ""}">\n    ${s.replace("<!--cover-->", "").trim()}\n  </section>`).join("\n")}
</body>
</html>`;
}

function cover(eyebrow: string, title: string): string {
  return `<!--cover--><p class="eyebrow">${escapeHtml(eyebrow)}</p>\n    <h1>${escapeHtml(title)}</h1>`;
}

export const DECK_TEMPLATES: DeckTemplate[] = [
  {
    id: "proposal",
    name: "Proposal",
    description: "Client proposal skeleton — context, approach, scope, pricing, next steps.",
    build: (title) =>
      doc(title, [
        cover("Proposal", title),
        `<p class="eyebrow">The situation</p>\n    <h2>Where things stand</h2>\n    <p class="lead">One or two sentences on the client's current state and why now. Replace this with the specific context you heard in the call.</p>`,
        `<p class="eyebrow">Approach</p>\n    <h2>How we'd tackle it</h2>\n    <ul><li>Phase 1 — discovery and the first concrete output</li><li>Phase 2 — the build</li><li>Phase 3 — handoff and what "done" means</li></ul>`,
        `<p class="eyebrow">Scope</p>\n    <h2>What's in, what's out</h2>\n    <div class="grid"><div class="card"><h3>In scope</h3><p>The deliverables you're committing to.</p></div><div class="card"><h3>Out of scope</h3><p>What you're explicitly NOT doing, so there's no ambiguity later.</p></div></div>`,
        `<p class="eyebrow">Investment</p>\n    <h2>Pricing</h2>\n    <p class="lead">Structure, amount, and what it covers. Keep it specific.</p>`,
        `<p class="eyebrow">Next steps</p>\n    <h2>From here</h2>\n    <ul><li>What you need from them to start</li><li>The first milestone and its date</li><li>How to say yes</li></ul>`,
      ]),
  },
  {
    id: "pitch",
    name: "Pitch deck",
    description: "Startup pitch — problem, solution, market, traction, ask.",
    build: (title) =>
      doc(title, [
        cover("Pitch", title),
        `<p class="eyebrow">Problem</p>\n    <h2>The problem</h2>\n    <p class="lead">The painful, specific problem a real person has today. Make it concrete.</p>`,
        `<p class="eyebrow">Solution</p>\n    <h2>What we built</h2>\n    <p class="lead">How the product solves it, in one breath. Show, don't list features.</p>`,
        `<p class="eyebrow">Market</p>\n    <h2>Why now, how big</h2>\n    <div class="grid"><div class="card"><h3>Why now</h3><p>The shift that makes this possible today.</p></div><div class="card"><h3>Size</h3><p>The market, sized honestly.</p></div></div>`,
        `<p class="eyebrow">Traction</p>\n    <h2>What's working</h2>\n    <ul><li>The number that matters most</li><li>Growth rate or a notable logo</li><li>One proof the dogs eat the dog food</li></ul>`,
        `<p class="eyebrow">The ask</p>\n    <h2>What we're raising</h2>\n    <p class="lead">Amount, what it buys, and the milestone it gets you to.</p>`,
      ]),
  },
  {
    id: "report",
    name: "One-pager report",
    description: "Findings report — summary, what we found, recommendation.",
    build: (title) =>
      doc(title, [
        cover("Report", title),
        `<p class="eyebrow">Summary</p>\n    <h2>The short version</h2>\n    <p class="lead">The one thing the reader should walk away with, up front. If they read nothing else, this.</p>`,
        `<p class="eyebrow">Findings</p>\n    <h2>What we found</h2>\n    <ul><li>Finding one, with the evidence behind it</li><li>Finding two</li><li>Finding three</li></ul>`,
        `<p class="eyebrow">Recommendation</p>\n    <h2>What to do about it</h2>\n    <p class="lead">The specific action, who owns it, and by when.</p>`,
      ]),
  },
];

export function getDeckTemplate(id: string): DeckTemplate | undefined {
  return DECK_TEMPLATES.find((t) => t.id === id);
}
