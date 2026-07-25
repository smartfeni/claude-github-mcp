import { defineConfig } from "vitest/config";

// Plain Node test environment: this connector's logic (repo/path/query
// validation, HTML escaping) is pure TypeScript with no
// Cloudflare Workers runtime dependency, so there's no need for
// @cloudflare/vitest-pool-workers here. `Env` is a plain interface and can
// be satisfied with hand-built object literals in tests.
export default defineConfig({
  test: {
    environment: "node",
  },
});
