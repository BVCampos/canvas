#!/usr/bin/env node
// Release the canvas-agent bridge. The version lives in TWO places that must move
// together:
//   1. bridge/package.json        — the source of truth; the bridge reports it to
//      Canvas on every poll (x-bridge-version header, migration 0051).
//   2. app/.../assistant-panel.tsx LATEST_BRIDGE_VERSION — what an online bridge's
//      reported version is compared against to show the "update available" nudge.
//
// app/tests/bridge-version-sync.test.ts fails CI if they drift; this script is how
// you keep them honest. Usage:
//
//   node scripts/release-bridge.mjs 0.2.0
//
// Then commit and tag (the tag push triggers .github/workflows/publish-bridge.yml):
//   git commit -am "release: canvas-agent v0.2.0"
//   git tag canvas-agent-v0.2.0 && git push --follow-tags

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/release-bridge.mjs <major.minor.patch>");
  process.exit(1);
}

// 1. bridge/package.json — the source of truth.
const pkgPath = join(root, "bridge/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prev = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. bridge/package-lock.json — keep the lockfile's own version fields in step so
//    `npm ci` from source doesn't complain.
const lockPath = join(root, "bridge/package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = version;
if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");

// 3. The app's pin — what a running bridge's reported version is compared against.
const panelPath = join(root, "app/src/app/canvases/[id]/assistant-panel.tsx");
let panel = readFileSync(panelPath, "utf8");
const pin = /const LATEST_BRIDGE_VERSION = "[^"]*";/;
if (!pin.test(panel)) {
  console.error("could not find LATEST_BRIDGE_VERSION pin in assistant-panel.tsx");
  process.exit(1);
}
panel = panel.replace(pin, `const LATEST_BRIDGE_VERSION = "${version}";`);
writeFileSync(panelPath, panel);

console.log(`canvas-agent ${prev} → ${version}`);
console.log("next:");
console.log(`  git commit -am "release: canvas-agent v${version}"`);
console.log(`  git tag canvas-agent-v${version} && git push --follow-tags`);
