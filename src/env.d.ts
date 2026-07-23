// Augments the ambient `Env` interface that `wrangler types` generates from
// wrangler.jsonc (see worker-configuration.d.ts) with the two secrets that
// are deliberately NOT in wrangler.jsonc — they're set with
// `wrangler secret put GITHUB_PAT` / `wrangler secret put CONNECTOR_PASSWORD`
// so they never appear in a config file.
export {};

declare global {
  interface Env {
    GITHUB_PAT: string;
    CONNECTOR_PASSWORD: string;
  }
}
