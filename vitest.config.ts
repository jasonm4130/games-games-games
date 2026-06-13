import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (Miniflare). We use a minimal local config
// rather than pointing at wrangler.jsonc, because the AI and Vectorize bindings are
// remote-only (`remote: true`) and would require live Cloudflare auth to start the
// pool. Worker-integration tests that need D1/R2/the agent can extend `miniflare`
// here with local bindings and mock AI/Vectorize.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-06-13",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
