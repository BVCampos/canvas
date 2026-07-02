// Capture 6 screenshots of the running canvas dev server for the Remotion walkthrough.
//
// Approach: mint a magic link for the test user via the Supabase admin client,
// follow it once to set the session cookie, then walk the route list.
//
// Requires: `npm run dev` running on :3001 in app/. Reads SUPABASE_SECRET_KEY
// from app/.env.local.

import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import * as dotenv from "dotenv";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const remotionRoot = path.resolve(__dirname, "..");
const appRoot = path.resolve(remotionRoot, "../app");
dotenv.config({ path: path.join(appRoot, ".env.local") });

const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
const serviceRoleKey = required("SUPABASE_SECRET_KEY");

// Capture renders the live product, so point it at a SYNTHETIC deck — never a
// real client deck (committed stills would leak client content).
const BASE_URL = process.env.CANVAS_BASE_URL ?? "http://localhost:3001";
const USER_EMAIL = required("CANVAS_USER_EMAIL");
const DECK_ID = required("CANVAS_DECK_ID");
const PROPOSAL_ID = required("CANVAS_PROPOSAL_ID");

const shotsDir = path.join(remotionRoot, "public", "shots");
mkdirSync(shotsDir, { recursive: true });

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing ${key} in app/.env.local`);
    process.exit(2);
  }
  return v;
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main(): Promise<void> {
  console.log(`Capture — base ${BASE_URL}, deck ${DECK_ID}`);

  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: USER_EMAIL,
    options: { redirectTo: `${BASE_URL}/canvases` },
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(`generateLink failed: ${error?.message ?? "no hashed_token"}`);
  }
  const tokenHash = data.properties.hashed_token;
  // The app exposes /auth/confirm?token_hash=...&type=magiclink which calls
  // verifyOtp server-side and sets the SSR session cookie. Bypass Supabase's
  // implicit-flow URL hash entirely.
  const confirmUrl =
    `${BASE_URL}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}` +
    `&type=magiclink&next=${encodeURIComponent("/canvases")}`;
  console.log("  ✓ minted magic link");

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await page.goto(confirmUrl, { waitUntil: "networkidle2", timeout: 30_000 });
  const after = page.url();
  console.log(`  ✓ post-auth url: ${after}`);
  if (after.includes("/login") || after.includes("/auth/confirm")) {
    throw new Error(`Auth did not complete (landed on ${after})`);
  }

  const shots = [
    { name: "01-decks", url: `${BASE_URL}/canvases` },
    { name: "02-editor", url: `${BASE_URL}/canvases/${DECK_ID}` },
    {
      name: "03-proposal",
      url: `${BASE_URL}/canvases/${DECK_ID}/proposals/${PROPOSAL_ID}`,
    },
    { name: "04-inbox", url: `${BASE_URL}/canvases/inbox` },
    { name: "05-history", url: `${BASE_URL}/canvases/${DECK_ID}/history` },
    { name: "06-mcp", url: `${BASE_URL}/settings/mcp` },
  ];

  for (const shot of shots) {
    await page.goto(shot.url, { waitUntil: "networkidle2", timeout: 45_000 });
    // Give the slide iframe / proposal diff / etc. extra time to settle.
    await new Promise((r) => setTimeout(r, 2200));
    const outPath = path.join(shotsDir, `${shot.name}.png`);
    await page.screenshot({ path: outPath, type: "png", fullPage: false });
    console.log(`  ✓ ${shot.name} → ${path.relative(remotionRoot, outPath)}`);
  }

  // 07-snapshot: open the deck editor, click the toolbar "Snapshot" button,
  // wait for the dialog to mount and autofocus the Label input, then shoot.
  // The dialog covers the slide preview, so the screenshot shows it centred
  // over the editor — clean visual for the walkthrough scene.
  await page.goto(`${BASE_URL}/canvases/${DECK_ID}`, {
    waitUntil: "networkidle2",
    timeout: 45_000,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Snapshot",
    );
    if (!btn) return false;
    (btn as HTMLElement).click();
    return true;
  });
  if (!clicked) {
    console.warn("  ⚠ snapshot button not found — skipping 07-snapshot");
  } else {
    // Wait for the dialog autofocus / animation to settle.
    await new Promise((r) => setTimeout(r, 900));
    const outPath = path.join(shotsDir, "07-snapshot.png");
    await page.screenshot({ path: outPath, type: "png", fullPage: false });
    console.log(`  ✓ 07-snapshot → ${path.relative(remotionRoot, outPath)}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
