# github-readonly-mcp

A small, self-hosted MCP connector that gives Claude **read-only** access to
your GitHub repos — including private ones. Which repos are reachable is
determined entirely by the scope of the GitHub token you give it (see below),
not by a list in the code. It exists because:

- Cowork's cloud sandbox blocks direct calls to `api.github.com` (you'll get
  `403 GitHub access to this repository is not enabled for this session`).
- GitHub's own official remote MCP server (`api.githubcopilot.com/mcp`) needs
  a GitHub App OAuth flow that Claude's custom-connector UI doesn't support
  (it only takes an OAuth Client ID/Secret, not GitHub's flow).
- Broader third-party connectors grant read **and** write access, which is
  more than this needs.

This connector is deliberately narrow: it runs on Cloudflare Workers (free
tier is plenty), gates access behind a single shared password + OAuth 2.1,
and exposes exactly 7 read-only tools. The reachable repos are whatever the
GitHub token can read — scope the token, not the code. **There is no write
path in the code at all** — no create/update/delete/merge function exists
anywhere, so it can't modify GitHub no matter what a model asks it to do.

Tools it exposes: `list_repos`, `list_commits`, `list_branches`,
`list_pull_requests`, `list_issues`, `get_file_contents`, `search_code`.

Everything below has already been tested locally end-to-end (dynamic client
registration → password-gated authorize → token exchange → authenticated MCP
session → tools/list → tools/call, including a real 401 from GitHub with a
placeholder token and a correctly-rejected malformed repo name). What's
left is deploying it for real and connecting it to Claude.

## 1. Prerequisites

- Node.js 18+ and npm (already used to build this).
- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- A GitHub **fine-grained personal access token**, read-only. **This token is
  the connector's only access boundary** — it can read exactly the repos the
  token can, so scope it deliberately:
  https://github.com/settings/personal-access-tokens/new
  - Repository access: "Only select repositories" → pick exactly the repos you
    want reachable (or "All repositories" if you truly want full read access).
  - Permissions: Contents (Read-only), Metadata (Read-only), Pull requests
    (Read-only), Issues (Read-only). Don't grant anything else.

## 2. Install dependencies

```bash
cd github-readonly-mcp
npm install
```

## 3. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser to authorize the Wrangler CLI against your Cloudflare
account.

## 4. Create the KV namespace

`@cloudflare/workers-oauth-provider` needs a KV namespace to store OAuth
grants and token hashes (no secrets are stored in plaintext — just hashes).

```bash
npx wrangler kv namespace create OAUTH_KV
```

This prints something like:

```
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "abcd1234...."
```

Copy that `id` value into `wrangler.jsonc`, replacing the placeholder:

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "abcd1234...." }  // <- your real id here
],
```

## 5. Set the two secrets

These are **never** written to wrangler.jsonc or committed anywhere — they
live only in Cloudflare's encrypted secret store.

```bash
npx wrangler secret put GITHUB_PAT
# paste your fine-grained GitHub PAT when prompted

npx wrangler secret put CONNECTOR_PASSWORD
# choose a real password — this is the one gate between the internet and
# your GitHub read tools, so make it a proper passphrase, not "test123"
```

## 6. (No allow-list to configure)

There is no repo allow-list in this connector: it can read any repo the
`GITHUB_PAT` grants. The token you scoped in step 1 **is** the boundary —
if you want to narrow what's reachable, narrow the token's repository access,
then rotate it (step 5 / "Updating later"). The connector still validates that
each `repo` argument is a well-formed `"owner/name"` before calling GitHub, so
malformed values can't be used to reach unintended API paths.

## 7. Deploy

```bash
npm run deploy
```

Wrangler will print a URL like `https://github-readonly-mcp.<your-subdomain>.workers.dev`.
That's your connector's base URL — save it, you'll need it in the next step.

Sanity-check it:

```bash
curl https://github-readonly-mcp.<your-subdomain>.workers.dev/health
# -> "github-readonly-mcp is running. Connect it to Claude as a custom connector."
```

## 8. Add it to Claude as a custom connector

1. In Claude, go to **Settings → Connectors → Add custom connector**.
2. Name it something like "GitHub (read-only)".
3. Remote MCP server URL: `https://github-readonly-mcp.<your-subdomain>.workers.dev/mcp`
4. Save. Claude will kick off the OAuth flow: it hits `/register` automatically,
   then opens the `/authorize` page in step 9.

## 9. Authorize it

You'll land on a small dark-themed page titled "Authorize Claude." Enter the
`CONNECTOR_PASSWORD` you set in step 5 and submit. That's the only manual
gate — after this, Claude holds a scoped OAuth token and can call the 7
tools directly.

## 10. Verify it works

Ask Claude something like "using the GitHub read-only connector, list
recent commits on jpalvarezb/bonafe" and confirm it returns real commit
data (not a 401). You can also ask it to `list_repos` to see everything the
token can reach.

## 11. Tell me once it's connected

Once steps 1–10 are done, let me know — I'll delete and recreate the
"Daily Schedule Review (cloud)" scheduled task so its connector list picks
up this new one, then we'll run one more supervised test exercising
`list_commits` / `list_pull_requests` / `list_issues` against your real repos
with real credentials, to confirm the whole chain works end-to-end.

## Updating later

Changed a tool, re-scoped the repos, or rotated the PAT? (Re-scoping the
reachable repos now means issuing a new fine-grained token and rotating it —
there's no list in the code to edit.)

```bash
npm run deploy          # code/config changes
npx wrangler secret put GITHUB_PAT   # to rotate the token
```

No need to touch the OAuth setup again — Claude's existing connection keeps
working across redeploys as long as the KV namespace and secrets stay in
place.

## Security notes

- **Read-only by construction, not by policy.** There is no function in
  `src/github.ts` (or anywhere else) that issues a POST/PATCH/PUT/DELETE to
  GitHub. A prompt injection or a misbehaving model can't make this
  connector write to GitHub — the code to do so doesn't exist.
- **The GitHub token is the access boundary.** There is no repo allow-list;
  the connector can read exactly what the `GITHUB_PAT` can. Use a fine-grained,
  read-only token scoped to just the repos you want reachable. The connector
  does validate that each `repo` argument is a well-formed `"owner/name"`
  before calling GitHub, which prevents malformed values from being smuggled
  into unintended API paths — but that is an injection guard, not access
  control. **Anyone who has the connector password can read every repo the
  token can**, so keep both the token narrow and the password strong.
- **Secrets never touch source control.** `GITHUB_PAT` and
  `CONNECTOR_PASSWORD` are Cloudflare secrets (`wrangler secret put`), not
  `vars` in wrangler.jsonc, and `.dev.vars` is gitignored.
- **One shared password, by design.** The `/authorize` gate uses a single
  password rather than a full user-account system because this connector
  has exactly one legitimate caller — you, connecting your own Claude to
  your own GitHub data. If you ever want to share it with others, that
  authorize.ts gate is the one place to revisit.

## Project layout

```
src/
  index.ts       OAuthProvider wiring: routes /authorize, /token, /register, /mcp
  authorize.ts   Password-gated consent page (the only manual step)
  mcp-agent.ts   MCP server: registers the 7 read-only tools
  github.ts      GitHub REST wrapper — GET-only, "owner/name" format-validated
  env.d.ts       Adds GITHUB_PAT/CONNECTOR_PASSWORD to wrangler's generated Env type
wrangler.jsonc   Worker config: DO binding, KV binding
```
