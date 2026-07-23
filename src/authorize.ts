// A deliberately minimal login gate: one shared password (the CONNECTOR_PASSWORD
// secret), not a full user-account system. That's an appropriate trade-off here
// because this connector has exactly one legitimate caller (you, connecting
// Claude to your own GitHub read-only data) rather than many end users needing
// separate identities.
//
// This file only decides "is this really you connecting" — it has no
// involvement in what the connector can do once connected. That's entirely
// determined by which tools exist in mcp-agent.ts (all read-only).
//
// `Env` referenced below is the ambient global type (wrangler-generated +
// env.d.ts augmentation) — no import needed, see mcp-agent.ts for why.

interface OAuthReqInfo {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  [key: string]: unknown;
}

interface OAuthHelpers {
  parseAuthRequest(request: Request): Promise<OAuthReqInfo>;
  lookupClient(clientId: string): Promise<{ clientName?: string; clientId: string } | null>;
  completeAuthorization(opts: {
    request: OAuthReqInfo;
    userId: string;
    metadata: Record<string, unknown>;
    scope: string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}

function renderForm(opts: { clientName: string; error?: string; encodedReq: string }): string {
  const { clientName, error, encodedReq } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect GitHub (read-only)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; width: 320px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    p.sub { color: #8b949e; font-size: 13px; margin: 0 0 20px; }
    label { display: block; font-size: 13px; margin-bottom: 6px; color: #c9d1d9; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 14px; margin-bottom: 14px; }
    button { width: 100%; padding: 10px 12px; border-radius: 6px; border: none; background: #238636; color: white; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #2ea043; }
    .error { color: #f85149; font-size: 13px; margin-bottom: 12px; }
    .scope { font-size: 12px; color: #8b949e; margin-top: 18px; border-top: 1px solid #30363d; padding-top: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize ${clientName}</h1>
    <p class="sub">Read-only GitHub access via your schedule agent connector.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST">
      <input type="hidden" name="oauthReq" value="${encodedReq}" />
      <label for="password">Connector password</label>
      <input type="password" id="password" name="password" autofocus required />
      <button type="submit">Authorize</button>
    </form>
    <div class="scope">
      Grants: list commits, branches, pull requests, issues, and read file contents
      on the repos this connector is configured for. No write access exists in
      this connector at all &mdash; it cannot push, comment, merge, or modify
      anything on GitHub.
    </div>
  </div>
</body>
</html>`;
}

export async function handleAuthorizeGet(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const html = renderForm({
    clientName: client?.clientName || "Claude",
    encodedReq: btoa(JSON.stringify(oauthReqInfo)),
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function handleAuthorizePost(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get("password") || "");
  const encodedReq = String(form.get("oauthReq") || "");
  const oauthReqInfo: OAuthReqInfo = JSON.parse(atob(encodedReq));

  if (password !== env.CONNECTOR_PASSWORD) {
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
    const html = renderForm({
      clientName: client?.clientName || "Claude",
      error: "Incorrect password.",
      encodedReq,
    });
    return new Response(html, { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: "jp",
    metadata: { label: "Schedule agent GitHub connector" },
    scope: ["github:read"],
    props: { approved: true },
  });

  return Response.redirect(redirectTo, 302);
}
