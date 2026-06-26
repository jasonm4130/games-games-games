import { defineConfig } from "vitest/config";

// Plain Node pool — the lib/*.test.ts here (align, http, preserve) are pure-logic unit tests
// with no workerd APIs, so they must NOT run on the Cloudflare Workers pool the Worker uses.
export default defineConfig({
  test: { environment: "node" },
});
