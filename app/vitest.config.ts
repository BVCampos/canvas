import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local so test files that touch the Supabase env module don't blow
// up at import time. Tests that hit Supabase still require a real connection;
// for unit-only suites, dummy values keep `env.ts` happy.
dotenv.config({ path: resolve(__dirname, ".env.local") });

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
}
if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
}
if (!process.env.SUPABASE_SECRET_KEY) {
  process.env.SUPABASE_SECRET_KEY = "test-secret-key";
}

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      // Vitest runs server modules under Node's default export condition; the
      // server-only marker intentionally throws there. Tests exercise these
      // modules as server code, so resolve the marker's react-server no-op.
      "server-only": resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The db/ suite spins up a fresh pglite and replays every migration per test
    // (~1.5s alone, more under full-suite parallelism). That brushed the 5s
    // default and flaked CI as the migration count grew; 20s keeps slow-but-valid
    // DB tests green without masking a genuinely hung test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
