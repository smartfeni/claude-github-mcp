import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { GitHubReadOnlyMCP } from "./mcp-agent";
import { handleAuthorizeGet, handleAuthorizePost } from "./authorize";

export { GitHubReadOnlyMCP };

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      const oauthEnv = env as unknown as Parameters<typeof handleAuthorizeGet>[1];
      if (request.method === "GET") return handleAuthorizeGet(request, oauthEnv);
      if (request.method === "POST") return handleAuthorizePost(request, oauthEnv);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("github-readonly-mcp is running. Connect it to Claude as a custom connector.", {
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: GitHubReadOnlyMCP.serve("/mcp"),
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["github:read"],
});
