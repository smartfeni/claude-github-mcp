import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listRepos,
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
  .describe('Repository as "owner/name", e.g. "jpalvarezb/bonafe". Any repo the connector\'s GitHub token can read is reachable; call list_repos if unsure what\'s available.');

export class GitHubReadOnlyMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "github-readonly", version: "1.0.0" });

  async init() {
    const env = (this as unknown as { env: Env }).env;

    this.server.tool(
      "list_repos",
      "List the repositories this connector's GitHub token can read (most recently pushed first). Call this first if unsure what's available.",
      { limit: z.number().int().min(1).max(100).default(30) },
      async ({ limit }) => {
        try {
          return text(await listRepos(env, limit));
        } catch (err) {
          return errorText(err);
        }
      },
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
      "Read a file or list a directory. Use start_line and end_line to read a specific 1-based line range instead of the whole file.",
      {
        repo: repoParam,
        path: z.string(),
        ref: z.string().optional().describe("Branch, tag, or commit SHA."),
        start_line: z.number().int().min(1).optional().describe("First line to return, starting at 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to return, inclusive."),
      },
      async ({ repo, path, ref, start_line, end_line }) => {
        try {
          const result = await getFileContents(env, repo, path, ref);

          if (result.type === "file" && typeof result.content === "string") {
            const lines = result.content.split("\n");

            if (start_line !== undefined || end_line !== undefined) {
              const first = start_line ?? 1;
              const last = end_line ?? lines.length;

              if (last < first) {
                throw new Error("end_line must be greater than or equal to start_line.");
              }

              return {
                content: [{
                  type: "text" as const,
                  text: lines
                    .slice(first - 1, last)
                    .map((line, index) => `${first + index}: ${line}`)
                    .join("\n"),
                }],
              };
            }

            return {
              content: [{ type: "text" as const, text: result.content ?? "" }],
            };
          }

          return text(result);
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
