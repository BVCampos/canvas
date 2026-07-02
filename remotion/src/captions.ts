export type Scene = {
  shot: string;
  step: string;
  caption: string;
  detail: string;
};

export const SCENES: Scene[] = [
  {
    shot: "01-decks.png",
    step: "Open",
    caption: "Your decks live here.",
    detail: "One workspace, every HTML deck. Click in.",
  },
  {
    shot: "02-editor.png",
    step: "Edit",
    caption: "Three-pane editor.",
    detail: "Slides on the left. Live preview in the middle. Comments + proposals on the right.",
  },
  {
    shot: "03-proposal.png",
    step: "Propose",
    caption: "Claude proposes a diff.",
    detail: "Every edit lands as a reviewable change — never a silent overwrite.",
  },
  {
    shot: "04-inbox.png",
    step: "Approve",
    caption: "One inbox for every pending edit.",
    detail: "Approve, reject, or open the slide to dig in.",
  },
  {
    shot: "05-history.png",
    step: "Version",
    caption: "Every applied edit is a new version.",
    detail: "Roll forward to any snapshot. Nothing is ever lost.",
  },
  {
    shot: "07-snapshot.png",
    step: "Snapshot",
    caption: "Freeze the deck before a risky edit.",
    detail: "Name a snapshot, save it, restore later with one click.",
  },
  {
    shot: "06-mcp.png",
    step: "Connect",
    caption: "Wire Claude in with one MCP token.",
    detail: "Your Claude session edits the deck through the same RPC the UI uses.",
  },
];

export const FPS = 30;
export const SCENE_FRAMES = 150;
export const TOTAL_FRAMES = SCENES.length * SCENE_FRAMES;
export const WIDTH = 1920;
export const HEIGHT = 1080;
