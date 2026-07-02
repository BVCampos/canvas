import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
const targets = [
  "http://localhost:3001/login",
  "https://example.com",
  "https://hgmgzerslymgoqrrahev.supabase.co/",
];
for (const url of targets) {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    console.log("  ✓", url, "→", res?.status());
  } catch (e) {
    console.log("  ✗", url, "→", (e as Error).message.slice(0, 80));
  }
}
await browser.close();
