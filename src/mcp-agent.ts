import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  allowedRepos,
  listCommits,
  listBranches,
  listPullRequests,
  listIssues,
  getFileContents,
  searchCode,
} from "./github";
// Env's GITHUB_PAT/CONNECTOR_PASSWORD augmentation (env.d.ts) is picked up
// automatically via tsconfig's "include" — no import needed for ambient types.

// Props attached to the OAuth grant that authorized this connection. Our login
// gate is a single shared password (see authorize.ts) rather than per-user
// identity, so there's just one flag to carry through.
type Props = { approved: true };

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorText(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

const repoParam = z
  .string()
  .describe('Repository as "owner/name", e.g. "jpalvarezb/bonafe". Must be on this connector\'s allow-list.');

export class GitHubReadOnlyMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "github-readonly", version: "1.0.0" });

  async init() {
    const env = this.env;

    this.server.tool(
      "list_allowed_repos",
      "List the repositories this connector is allowed to read. Call this first if unsure what's in scope.",
      {},
      async () => text({ allowed_repos: allowedRepos(env) }),
    );

    this.server.tool(
      "list_commits",
      "List recent commits on a repo/branch, most recent first. Use this to check whether work described in a task or PR is already merged before creating duplicate work.",
      {
        repo: repoParam,
        branch: z.string().optional().describe("Branch or ref name; defaults to the repo's default branch."),
        limit: z.number().int().min(1).max(50).default(20),
      },
      async ({ repo, branch, limit }) => {
        try {
          return text(await listCommits(env, repo, branch, limit));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    this.server.tool(
      "list_branches",
      "List branches on a repo. Unmerged branches are a reasonable proxy for in-flight work when PR data isn't otherwise available.",
      { repo: repoParam },
      async ({ repo }) => {
        try {
          return text(await listBranches(env, repo));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    this.server.tool(
      "list_pull_requests",
      "List pull requests on a repo (open by default).",
      { repo: repoParam, state: z.enum(["open", "closed", "all"]).default("open") },
      async ({ repo, state }) => {
        try {
          return text(await listPullRequests(env, repo, state));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    this.server.tool(
      "list_issues",
      "List issues on a repo (open by default). Pull requests are excluded from the results.",
      { repo: repoParam, state: z.enum(["open", "closed", "all"]).default("open") },
      async ({ repo, state }) => {
        try {
          return text(await listIssues(env, repo, state));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    this.server.tool(
      "get_file_contents",
      "Read a file or list a directory's contents at a given path and ref (e.g. README.md, a roadmap doc, or a directory listing). Paths are repo-relative: absolute paths (leading '/') and traversal segments ('.'/'..') are rejected. Use an empty path to list the repo root.",
      { repo: repoParam, path: z.string(), ref: z.string().optional().describe("Branch, tag, or commit SHA.") },
      async ({ repo, path, ref }) => {
        try {
          return text(await getFileContents(env, repo, path, ref));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    this.server.tool(
      "search_code",
      "Search code within a single repo (GitHub code search syntax). The search is already scoped to the given repo, so queries may not contain their own 'repo:', 'org:', or 'user:' qualifiers -- those are rejected.",
      { repo: repoParam, query: z.string() },
      async ({ repo, query }) => {
        try {
          return text(await searchCode(env, repo, query));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    // Deliberately no write tools are registered anywhere in this class: no
    // create/update/delete/merge/comment/label tool exists to call, so this
    // connector cannot modify GitHub state no matter what a caller asks for.
  }
}
