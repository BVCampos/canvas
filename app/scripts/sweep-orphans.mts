// Sweep orphaned canvas storage objects (paths whose deck_id segment has no
// matching canvas_deck row). One-time-ish maintenance script — until a
// scheduled job is added, run by hand:
//
//   set -a; source .env.local; set +a
//   npx tsx scripts/sweep-orphans.mts

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";

const admin = createAdminClient();

async function listAll(prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { data, error } = await admin.storage.from("decks").list(prefix, { limit: 1000 });
  if (error || !data) return out;
  for (const entry of data) {
    if (entry.id === null) {
      // folder — recurse
      const subPaths = await listAll(`${prefix}/${entry.name}`);
      out.push(...subPaths);
    } else {
      out.push(`${prefix}/${entry.name}`);
    }
  }
  return out;
}

const { data: workspaceFolders } = await admin.storage.from("decks").list("", { limit: 100 });
if (!workspaceFolders) {
  console.log("nothing to sweep");
  process.exit(0);
}

const allPaths: string[] = [];
for (const ws of workspaceFolders) {
  if (ws.id !== null) continue; // skip stray files at root
  const paths = await listAll(ws.name);
  allPaths.push(...paths);
}

console.log(`found ${allPaths.length} storage objects under decks/`);

// Bucket the paths by deck_id (the second path segment), then query which
// deck_ids actually exist.
const deckIds = new Set<string>();
for (const p of allPaths) {
  const parts = p.split("/");
  if (parts.length >= 2 && parts[1].length === 36) deckIds.add(parts[1]);
}

const { data: liveDecks } = await admin
  .from("canvas_deck")
  .select("id")
  .in("id", Array.from(deckIds));
const liveSet = new Set((liveDecks ?? []).map((d) => d.id as string));

const orphans = allPaths.filter((p) => {
  const deckId = p.split("/")[1];
  return !liveSet.has(deckId);
});

if (orphans.length === 0) {
  console.log("no orphans — clean");
  process.exit(0);
}

console.log(`removing ${orphans.length} orphans:`);
for (const o of orphans) console.log(`  - ${o}`);

const { data: removed, error } = await admin.storage.from("decks").remove(orphans);
console.log(`removed ${removed?.length ?? 0}${error ? ` · error: ${error.message}` : ""}`);
