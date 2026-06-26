import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// `agents()` handles the decorator transform used by @callable() agent methods.
// `cloudflare()` runs the Worker in workerd during `vite dev` (no separate wrangler dev).
export default defineConfig({
  plugins: [agents(), react(), cloudflare()],
});
