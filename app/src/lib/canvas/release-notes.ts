// Release notes shown on /releases. Hand-curated from the git history: one
// entry per day that shipped to main, newest first. When a release merges,
// add its user-facing items here (titles in plain product language, not
// commit-message language) — the page renders this module verbatim.

export type ReleaseTag = "feature" | "improvement" | "fix" | "infra";

export type ReleaseItem = {
  title: string;
  description: string;
  tag: ReleaseTag;
  /** GitHub PR numbers that shipped it (linked from the page). */
  prs?: number[];
};

export type Release = {
  /** ISO date (YYYY-MM-DD) the work landed on main. */
  date: string;
  /** Short headline for the day's drop. */
  title: string;
  items: ReleaseItem[];
};

export const GITHUB_REPO_URL = "https://github.com/BVCampos/canvas";

export const RELEASES: Release[] = [
  {
    date: "2026-07-13",
    title: "Import and export fixes",
    items: [
      {
        title: "PDF and PowerPoint exports capture every deck faithfully",
        description:
          "Export was tuned for the standard deck shape and quietly mangled everything else: slides of a different size came out stretched, decks that scale themselves could export cropped or with the wrong slide on a page, a hidden leftover element could fail the whole export, and speaker notes could land on the wrong PowerPoint slide. Each slide now exports at its own true size with its own notes.",
        tag: "fix",
      },
      {
        title: "Dark slides export without white bands",
        description:
          "PDF export painted a thin white band along the edges of dark slides — the on-screen letterbox was clipping the capture. Exports are edge-to-edge again.",
        tag: "fix",
        prs: [87],
      },
      {
        title: "Import accepts decks with embedded TTF/OTF fonts",
        description:
          "Uploading a deck whose HTML embeds a TTF or OTF font (or a BMP/ICO image) failed with a generic import error — the parser extracted the font but storage refused the file type. Those decks now import cleanly.",
        tag: "fix",
      },
    ],
  },
  {
    date: "2026-07-08",
    title: "Bring your own key",
    items: [
      {
        title: "Anthropic and OpenAI keys in Canvas chat",
        description:
          "The hosted Canvas chat now takes your own Anthropic or OpenAI API key, not just OpenRouter. Pick the provider in Settings → Connections, paste the key, and in-deck chat runs on Claude or GPT models directly — same propose-first tools, keys encrypted before storage.",
        tag: "feature",
      },
    ],
  },
  {
    date: "2026-07-07",
    title: "Resize, small-screen fit, and clearer onboarding",
    items: [
      {
        title: "Resize elements right on the slide",
        description:
          "Adjust mode now puts resize handles on the selected element: drag a corner or edge to resize it in place (hold Shift to keep the aspect ratio), just like moving it. The inspector panel also gained a Height field next to Width for exact pixel sizes.",
        tag: "feature",
      },
      {
        title: "Decks fit smaller screens",
        description:
          "Fixed-size decks that don't scale themselves now shrink to fit the window everywhere (the editor, Present, share links, and exported files) instead of scrambling on laptops and smaller displays.",
        tag: "fix",
        prs: [80],
      },
      {
        title: "Connections page leads with your agent",
        description:
          "Creating an access token is now the first thing on the Connections page, with the two setup paths named in plain language (work from your terminal, or chat inside Canvas) and a live check that flips green the moment your agent first connects. OpenRouter keys moved into a collapsed Advanced section.",
        tag: "improvement",
        prs: [81],
      },
      {
        title: "First-run guide on the deck list",
        description:
          "An empty workspace now walks you through the loop in order (connect your agent, create a deck, ask for edits) and connects your agent right on the page: token, setup command, and live check, with no detour to Settings. The topbar keeps a Connect your agent shortcut until one connects.",
        tag: "improvement",
        prs: [81],
      },
    ],
  },
  {
    date: "2026-07-04",
    title: "Archive decks",
    items: [
      {
        title: "Archive decks",
        description:
          "Shelve a finished or dormant deck out of your list without deleting it. Archived decks are hidden from the deck list behind an Archived tab, still open and edit normally, and unarchive in one click. Archive or unarchive from the deck's ⋯ menu.",
        tag: "feature",
      },
    ],
  },
  {
    date: "2026-07-02",
    title: "Idea wave + speed",
    items: [
      {
        title: "Share-link analytics",
        description:
          "Public links now track anonymous opens and per-slide dwell time, rolled up into an engagement report on each deck.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "Client feedback on public links",
        description:
          "Anyone with a share link can leave comments without an account. Their feedback lands in the deck's comment threads.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "Pre-flight check",
        description:
          "Render and audit a whole deck before it ships: overflowing text, broken images, low contrast, leftover placeholders.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "Brand kit",
        description:
          "Workspaces carry design tokens and voice rules that agents read before generating slides. Managed in Settings, Brand.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "A/B slide variants",
        description:
          "Ask an agent for variants of a slide, compare them side by side, and pick one. The pick applies in a single transaction.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "Cross-deck slide copy",
        description:
          "Copy a slide from one deck into another, assets included. The first step toward a slide library.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "Speaker notes",
        description:
          "Agents can write the talk track for each slide, and present mode shows it to the presenter.",
        tag: "feature",
        prs: [67],
      },
      {
        title: "A faster edit loop",
        description:
          "Eligible agent patches can apply through a trusted fast lane after a verified render, assistant turns stream in live, and approve round-trips were cut down.",
        tag: "improvement",
        prs: [68],
      },
      {
        title: "Assistant turns stop dying on images",
        description:
          "When the assistant needs to look at a slide render but its model is text-only, the image round relays to a vision model instead of failing mid-turn.",
        tag: "fix",
        prs: [69],
      },
      {
        title: "Release notes",
        description:
          "This page. Everything that ships lands here, tagged and linked to its pull request. Find it under What's new in the user menu.",
        tag: "feature",
        prs: [70],
      },
      {
        title: "A findable settings hub",
        description:
          "Settings opens straight from the user menu, with a new Account page for your display name and theme. The whole area (and this page) now uses the full window width, with a section rail on wide screens.",
        tag: "improvement",
        prs: [71],
      },
    ],
  },
  {
    date: "2026-07-01",
    title: "Slide-aware assistant + drawing",
    items: [
      {
        title: "Draw over a slide",
        description:
          "Annotate any slide freehand. The drawing rides an overlay proposal instead of rewriting the slide underneath.",
        tag: "feature",
        prs: [64],
      },
      {
        title: "The assistant knows your slide",
        description:
          "The in-app assistant folds the selected slide into your message, so \"fix the title here\" resolves without pasting context.",
        tag: "feature",
        prs: [62],
      },
      {
        title: "Snapshot restore recovers deleted slides",
        description:
          "Restoring a snapshot brings back slides that were deleted after it was taken. Snapshots are now self-contained.",
        tag: "fix",
        prs: [61],
      },
      {
        title: "Member inline edits propose again",
        description:
          "Members hand-editing a slide had every proposal fail on a phantom column. The save path targets the right version now.",
        tag: "fix",
        prs: [64],
      },
      {
        title: "The composer grows with your message",
        description:
          "The Ask-agent composer auto-grows with its content instead of scrolling inside a two-line box.",
        tag: "improvement",
        prs: [66],
      },
      {
        title: "Open-source export readiness",
        description:
          "The codebase can be exported as a fresh-history public snapshot, ready for an open-source release.",
        tag: "infra",
        prs: [65],
      },
    ],
  },
  {
    date: "2026-06-30",
    title: "Thumbnails that load",
    items: [
      {
        title: "Reliable deck and proposal thumbnails",
        description:
          "Thumbnails no longer blank out under load. Renders queue instead of being rejected, and images stay visible while they retry.",
        tag: "fix",
        prs: [59],
      },
      {
        title: "Credential encryption fails loud",
        description:
          "The server refuses to boot without its credential encryption key instead of failing quietly at request time.",
        tag: "infra",
        prs: [60],
      },
    ],
  },
  {
    date: "2026-06-29",
    title: "Bring any model",
    items: [
      {
        title: "Dual assistant runtime",
        description:
          "The in-app assistant can run on OpenRouter with your own API key, alongside the local Claude Code / Codex bridge. Clients are provider-agnostic.",
        tag: "feature",
        prs: [57],
      },
      {
        title: "Workspace-shared OpenRouter key",
        description:
          "Admins can share one OpenRouter key with the whole workspace, so members without their own key still get the assistant.",
        tag: "feature",
        prs: [58],
      },
    ],
  },
  {
    date: "2026-06-25",
    title: "Assistant control",
    items: [
      {
        title: "Stop an assistant turn",
        description:
          "A Stop button interrupts an in-flight assistant turn and keeps the partial output instead of discarding it.",
        tag: "feature",
        prs: [54],
      },
      {
        title: "Patch nudges + safe retries",
        description:
          "Agents that rewrite a whole slide for a small tweak get an actionable nudge toward patches, and withdrawing a proposal twice no longer errors.",
        tag: "improvement",
        prs: [55],
      },
    ],
  },
  {
    date: "2026-06-22",
    title: "The bridge goes installable",
    items: [
      {
        title: "One-command assistant bridge",
        description:
          "The local assistant bridge ships as a private npm package. One npx command connects Claude Code or Codex to the in-app chatbox.",
        tag: "feature",
        prs: [53],
      },
    ],
  },
  {
    date: "2026-06-21",
    title: "Platform wave",
    items: [
      {
        title: "Merge & approve",
        description:
          "Approving a stale proposal rebases it onto the current slide with a 3-way merge instead of clobbering edits made since it was proposed.",
        tag: "feature",
      },
      {
        title: "Notifications + presence",
        description:
          "@mentions and replies light up a topbar bell, and live collaborator avatars show who is on the open deck.",
        tag: "feature",
      },
      {
        title: "PPTX export and deck-wide agent tools",
        description:
          "Decks export to PPTX, and agents gained render_slide, render_deck, deck-wide patches, and history tools.",
        tag: "feature",
      },
      {
        title: "Starter templates",
        description:
          "New Deck starts from a set of starter templates instead of an empty page.",
        tag: "feature",
      },
      {
        title: "Members propose from inline edit",
        description:
          "Members can hand-edit any slide; saving routes the change through a proposal. Reviewers get multi-select approve and mobile compare.",
        tag: "feature",
      },
      {
        title: "Review shows the slide",
        description:
          "Proposal cards carry slide thumbnails, the inspector edits text directly, and realtime updates patch surgically instead of refetching.",
        tag: "improvement",
      },
      {
        title: "Agent token hardening",
        description:
          "Agent tokens expire and rotate, writes are capped against review-rail flooding, and the bridge authenticates with a dedicated header.",
        tag: "infra",
      },
      {
        title: "Create Deck unblocked on the new host",
        description:
          "Create Deck was blocked by CSP on the self-hosted deploy because redirects used the internal origin. Absolute URLs now come from the configured app URL.",
        tag: "fix",
        prs: [51, 52],
      },
    ],
  },
  {
    date: "2026-06-18",
    title: "Projects share like decks",
    items: [
      {
        title: "Project sharing",
        description:
          "Share a whole project the way you share a deck: visibility, members, guests, and a public link that cascades to every deck inside.",
        tag: "feature",
        prs: [49],
      },
      {
        title: "Drag to reposition",
        description:
          "Adjust mode lets you drag elements to move them around the slide, clamped to its bounds.",
        tag: "feature",
        prs: [46],
      },
      {
        title: "Hosting moved to AWS",
        description:
          "Canvas moved off Vercel onto an EC2 box behind a Cloudflare Tunnel, with rendering and PDF export on system Chromium.",
        tag: "infra",
        prs: [48],
      },
      {
        title: "Editor right rail refined",
        description:
          "A better assistant empty state, a clearer Send call to action, and collapsing Review and Comments sections.",
        tag: "improvement",
        prs: [47],
      },
      {
        title: "Batch approve respects staleness",
        description:
          "Approve-all no longer applies proposals whose slide moved underneath them, plus three smaller review bugs.",
        tag: "fix",
        prs: [50],
      },
      {
        title: "PDF export assembles natively",
        description:
          "The export assembles pages with pdf-lib instead of a second Chromium pass, making it faster and steadier.",
        tag: "fix",
        prs: [45],
      },
    ],
  },
  {
    date: "2026-06-17",
    title: "Ask an agent from inside Canvas",
    items: [
      {
        title: "In-app assistant",
        description:
          "A chatbox in the editor talks to Claude Code running on your own machine through a local bridge. Separate threads per deck, proposals reviewed inline.",
        tag: "feature",
        prs: [41],
      },
      {
        title: "PDF export made faithful",
        description:
          "Export stopped failing in production (Chromium binaries now ship with the route) and each slide renders at its native size, so layouts stop reflowing.",
        tag: "fix",
        prs: [42, 43, 44],
      },
    ],
  },
  {
    date: "2026-06-13",
    title: "One surface per act",
    items: [
      {
        title: "UI clarity pass",
        description:
          "Approve, review, and read each live in exactly one place now: review in the chip, read in the sheet, one queue per scope. The approve act was previously spread across three UIs.",
        tag: "improvement",
        prs: [40],
      },
    ],
  },
  {
    date: "2026-06-12",
    title: "Direct manipulation",
    items: [
      {
        title: "Adjust mode inspector",
        description:
          "Click any element on a slide and tweak its text, spacing, and colors directly, without going through an agent.",
        tag: "feature",
        prs: [39],
      },
      {
        title: "Element-anchored prompts",
        description:
          "Point an agent at a specific element on a slide. The prompt carries the anchor, so edits land where you meant.",
        tag: "feature",
        prs: [38],
      },
      {
        title: "Editing 10x fixes",
        description:
          "The first batch of fixes from watching a real 27-version editing session: fewer dead ends, clearer failure states.",
        tag: "improvement",
        prs: [37],
      },
    ],
  },
  {
    date: "2026-06-11",
    title: "Projects + a review queue that scales",
    items: [
      {
        title: "Projects",
        description:
          "Named groups of decks, built for proposals that span more than one deck.",
        tag: "feature",
        prs: [30],
      },
      {
        title: "Slide patches + activity feed",
        description:
          "Agents can propose surgical find-and-replace patches instead of full rewrites, the history page shows who did what, and comments gained moderation.",
        tag: "feature",
        prs: [29],
      },
      {
        title: "Bulk approve from the inbox",
        description:
          "Approve a whole stack of pending proposals in one action from the workspace inbox.",
        tag: "feature",
        prs: [31],
      },
      {
        title: "In-deck interactivity survives import",
        description:
          "Imported decks keep their non-slide chrome (modal overlays, dot navigation), so onclick interactivity keeps working.",
        tag: "fix",
        prs: [27],
      },
      {
        title: "Stale rewrites can't clobber your edits",
        description:
          "Full-slide rewrites proposed from stale context are caught by a base-version check instead of silently overwriting newer human edits.",
        tag: "fix",
        prs: [34],
      },
      {
        title: "Proposal decisions never get lost",
        description:
          "Deciding a proposal right before leaving the page no longer loses the decision, and rejected cards stop coming back.",
        tag: "fix",
        prs: [35],
      },
      {
        title: "Exports and imports keep assets straight",
        description:
          "Exported HTML keeps images referenced outside slide bodies, and imports dedupe byte-identical images instead of storing them repeatedly.",
        tag: "fix",
        prs: [32, 33],
      },
    ],
  },
  {
    date: "2026-06-10",
    title: "Any deck renders",
    items: [
      {
        title: "Fixed-pixel and PPTX decks render",
        description:
          "Decks authored at fixed pixel sizes (including PPTX imports) stopped rendering blank, via a viewport shim at the import boundary.",
        tag: "fix",
        prs: [26],
      },
      {
        title: "Edit pending proposals in place",
        description:
          "Reviewers can amend a pending proposal directly instead of rejecting it and asking for a new one.",
        tag: "feature",
        prs: [25],
      },
    ],
  },
  {
    date: "2026-06-02",
    title: "The slide editing suite",
    items: [
      {
        title: "Inline editing + the Lens",
        description:
          "Edit slides directly in the editor, bundle related edits into one proposal, and compare before/after with the Lens.",
        tag: "feature",
        prs: [20],
      },
      {
        title: "Self-approval setting",
        description:
          "Workspaces can let members approve their own proposals, for solo-heavy teams that review after the fact.",
        tag: "feature",
        prs: [24],
      },
      {
        title: "Export and mobile fixes",
        description:
          "Printed PDFs paginate one slide per page, portrait phones letterbox slides to 16:9, and vertically-stacked decks stop losing their scroll position.",
        tag: "fix",
        prs: [21, 22, 23],
      },
    ],
  },
  {
    date: "2026-06-01",
    title: "Post-launch hardening week",
    items: [
      {
        title: "Deck management basics",
        description:
          "Duplicate a slide, edit a deck's status, reject with an inline reason, and delete decks from the list page.",
        tag: "feature",
        prs: [11, 14],
      },
      {
        title: "Tolerant deck import",
        description:
          "The importer accepts any slide shape agents produce and fails loud only when it finds zero slides.",
        tag: "improvement",
        prs: [13],
      },
      {
        title: "Mobile polish",
        description:
          "Bigger tap targets, a viewport-stable shell, and touch-reachable slide actions on phones.",
        tag: "improvement",
        prs: [12],
      },
      {
        title: "Vertical deck navigation",
        description:
          "Vertically-stacked decks navigate by scroll position instead of a carousel transform, fixing skipped and misnumbered slides.",
        tag: "fix",
        prs: [15, 17, 19],
      },
      {
        title: "Failures surface instead of hanging",
        description:
          "A failed proposal-sheet load shows an error instead of an endless skeleton, and production guardrails were hardened.",
        tag: "fix",
        prs: [16, 18],
      },
    ],
  },
  {
    date: "2026-05-31",
    title: "Public links",
    items: [
      {
        title: "Share a deck with a link",
        description:
          "Any deck can get a world-readable public link, plus named slide titles for cleaner navigation.",
        tag: "feature",
        prs: [10],
      },
    ],
  },
  {
    date: "2026-05-30",
    title: "Outside reviewers",
    items: [
      {
        title: "Guest access",
        description:
          "Invite outside reviewers to a single deck with scoped guest access, without adding them to the workspace.",
        tag: "feature",
        prs: [9],
      },
    ],
  },
  {
    date: "2026-05-29",
    title: "Production hardening",
    items: [
      {
        title: "Security pass",
        description:
          "Iframe XSS protection, faster row-level-security checks, and authorization on every MCP surface.",
        tag: "infra",
        prs: [6],
      },
      {
        title: "UX backlog wave",
        description:
          "A batch of deferred UX items, plus fixes found by using Canvas to build real decks.",
        tag: "improvement",
        prs: [5, 7, 8],
      },
    ],
  },
  {
    date: "2026-05-28",
    title: "Standalone",
    items: [
      {
        title: "Canvas gets its own backend",
        description:
          "Canvas moved onto its own Supabase project with its own users and workspaces, fully separate from other 21x systems.",
        tag: "infra",
        prs: [4],
      },
    ],
  },
  {
    date: "2026-05-25",
    title: "Launch week",
    items: [
      {
        title: "Inline review chip",
        description:
          "Docs-style suggesting on the slide: proposed changes render as an inline chip you approve or reject in place.",
        tag: "feature",
        prs: [2],
      },
      {
        title: "Pre-launch readiness",
        description:
          "Security and UX hardening before the first outside users, and continuous deploys from GitHub Actions.",
        tag: "infra",
        prs: [1, 3],
      },
    ],
  },
  {
    date: "2026-05-22",
    title: "Canvas begins",
    items: [
      {
        title: "The first commit",
        description:
          "A multiplayer HTML-deck editor built propose-first: agents and people suggest changes as proposals, humans approve them, and every slide keeps its version history.",
        tag: "feature",
      },
    ],
  },
];
