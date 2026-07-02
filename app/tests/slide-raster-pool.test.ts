// The warm-browser pool inside slide-raster: one Chromium is launched once and
// reused across renders (open a page per render, close only the page), with an
// idle-close, a per-browser recycle cap, and automatic relaunch when Chromium
// dies. puppeteer-core is mocked with a fake browser/page so we can assert the
// LIFECYCLE (how many launches, page closes, browser closes) without a real
// Chromium. Each test imports slide-raster FRESH after stubbing the env knobs,
// since the pool reads them at module load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake browser/page instances delegate to this harness so assertions survive
// vi.resetModules() (which re-imports slide-raster and re-runs the mock factory).
type FakePage = {
  closed: boolean;
  close: () => Promise<void>;
  setViewport: () => Promise<void>;
  setContent: () => Promise<void>;
  evaluate: (fn: unknown, arg: unknown) => Promise<unknown>;
  addStyleTag: () => Promise<void>;
  $$: () => Promise<Array<{ screenshot: () => Promise<Uint8Array> }>>;
};
type FakeBrowser = {
  connected: boolean;
  newPageCount: number;
  closeCount: number;
  pages: FakePage[];
  disconnect: (() => void) | null;
  newPage: () => Promise<FakePage>;
  once: (event: string, cb: () => void) => void;
  close: () => Promise<void>;
};

const h = {
  launchCount: 0,
  browsers: [] as FakeBrowser[],
};

function makePage(): FakePage {
  return {
    closed: false,
    async close() {
      this.closed = true;
    },
    async setViewport() {},
    async setContent() {},
    // Two evaluate calls per render: the fonts.ready race (called with a number
    // timeout → return "settled") and the native-size read (called with the
    // fallback object → return a stage size).
    async evaluate(_fn: unknown, arg: unknown) {
      return typeof arg === "number" ? true : { w: 1920, h: 1080 };
    },
    async addStyleTag() {},
    async $$() {
      return [{ async screenshot() { return new Uint8Array([1]); } }];
    },
  };
}

function makeBrowser(): FakeBrowser {
  return {
    connected: true,
    newPageCount: 0,
    closeCount: 0,
    pages: [],
    disconnect: null,
    async newPage() {
      this.newPageCount += 1;
      const p = makePage();
      this.pages.push(p);
      return p;
    },
    once(event, cb) {
      if (event === "disconnected") this.disconnect = cb;
    },
    async close() {
      this.closeCount += 1;
      this.connected = false;
    },
  };
}

vi.mock("puppeteer-core", () => ({
  default: {
    launch: async () => {
      h.launchCount += 1;
      const b = makeBrowser();
      h.browsers.push(b);
      return b;
    },
  },
}));

// Import slide-raster fresh with the given pool env knobs applied.
async function load(env: Record<string, string>) {
  vi.resetModules();
  // Force launchBrowser onto the plain `puppeteer.launch({channel})` branch (the
  // mocked one) — no box Chromium path to accessSync, no serverless markers.
  delete process.env.CHROMIUM_PATH;
  delete process.env.VERCEL;
  delete process.env.AWS_LAMBDA_FUNCTION_VERSION;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return import("@/lib/canvas/slide-raster");
}

let mod: typeof import("@/lib/canvas/slide-raster") | null = null;

beforeEach(() => {
  h.launchCount = 0;
  h.browsers = [];
});

afterEach(async () => {
  // Tear down any warm browser + idle timer the test left armed.
  if (mod) await mod.closeSharedBrowser();
  mod = null;
});

describe("slide-raster warm-browser pool", () => {
  it("launches once and reuses the browser across sequential renders", async () => {
    mod = await load({ RENDER_BROWSER_IDLE_MS: "60000", RENDER_BROWSER_MAX_RENDERS: "40" });
    await mod.rasterizeDeckHtml("<html></html>");
    await mod.rasterizeDeckHtml("<html></html>");
    expect(h.launchCount).toBe(1);
    expect(h.browsers).toHaveLength(1);
    // One page per render, and each page was closed (not the browser).
    expect(h.browsers[0].newPageCount).toBe(2);
    expect(h.browsers[0].pages.every((p) => p.closed)).toBe(true);
    expect(h.browsers[0].closeCount).toBe(0);
  });

  it("relaunches after the browser disconnects (crash / OOM-kill)", async () => {
    mod = await load({ RENDER_BROWSER_IDLE_MS: "60000", RENDER_BROWSER_MAX_RENDERS: "40" });
    await mod.rasterizeDeckHtml("<html></html>");
    expect(h.launchCount).toBe(1);
    // Simulate Chromium dying between renders.
    h.browsers[0].connected = false;
    h.browsers[0].disconnect?.();
    await mod.rasterizeDeckHtml("<html></html>");
    expect(h.launchCount).toBe(2);
  });

  it("recycles the browser after RENDER_BROWSER_MAX_RENDERS renders", async () => {
    mod = await load({ RENDER_BROWSER_IDLE_MS: "60000", RENDER_BROWSER_MAX_RENDERS: "2" });
    await mod.rasterizeDeckHtml("<html></html>");
    await mod.rasterizeDeckHtml("<html></html>"); // hits the cap → close on release
    expect(h.browsers[0].closeCount).toBe(1);
    await mod.rasterizeDeckHtml("<html></html>"); // forces a relaunch
    expect(h.launchCount).toBe(2);
  });

  it("closes the idle browser after RENDER_BROWSER_IDLE_MS", async () => {
    mod = await load({ RENDER_BROWSER_IDLE_MS: "20", RENDER_BROWSER_MAX_RENDERS: "40" });
    await mod.rasterizeDeckHtml("<html></html>");
    expect(h.browsers[0].closeCount).toBe(0); // still warm right after the render
    await new Promise((r) => setTimeout(r, 60)); // let the idle timer fire
    expect(h.browsers[0].closeCount).toBe(1);
  });

  it("runs concurrent renders on one shared browser (pages, not processes)", async () => {
    mod = await load({ RENDER_BROWSER_IDLE_MS: "60000", RENDER_BROWSER_MAX_RENDERS: "40" });
    await Promise.all([
      mod.rasterizeDeckHtml("<html></html>"),
      mod.rasterizeDeckHtml("<html></html>"),
      mod.rasterizeDeckHtml("<html></html>"),
    ]);
    expect(h.launchCount).toBe(1);
    expect(h.browsers[0].newPageCount).toBe(3);
  });
});
