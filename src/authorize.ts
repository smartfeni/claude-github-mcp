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

// HTML-escapes a string before it's interpolated into a template literal
// (audit finding #3). `clientName` comes from `lookupClient`, and dynamic
// client registration is open (`/register` in index.ts), so an attacker can
// register a client whose name is e.g. "<script>...</script>" and have it
// reflected, unescaped, into this page's <h1> -- classic reflected XSS
// against whoever loads the authorize page. `&` must be escaped first so
// the entities produced for the other characters aren't themselves
// re-escaped.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Constant-time password comparison (audit finding #4). `password !==
// env.CONNECTOR_PASSWORD` is a plain string comparison whose running time
// depends on both the input length and the position of the first
// mismatched character, which a network attacker can in principle use to
// recover the password one byte at a time. Hashing both sides to a fixed
// 32-byte SHA-256 digest first means the buffers being compared are always
// the same length no matter what the caller submits, and XOR-accumulating
// every byte (instead of returning as soon as one differs) means the
// comparison itself always takes the same number of steps.
async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < digestA.length; i++) {
    diff |= digestA[i] ^ digestB[i];
  }
  return diff === 0;
}

export function renderForm(opts: { clientName: string; error?: string; encodedReq: string }): string {
  // Escape every value interpolated into the HTML, not just clientName:
  // `encodedReq` is submitted as a form field (attacker-controlled) and
  // `error` is defense-in-depth in case a caller-derived message is ever
  // passed here. `encodedReq` is base64 in practice, but escaping it costs
  // nothing and removes the assumption that it always will be.
  const clientName = escapeHtml(opts.clientName);
  const error = opts.error ? escapeHtml(opts.error) : opts.error;
  const encodedReq = escapeHtml(opts.encodedReq);
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

  // Audit finding #5: `oauthReq` is attacker-controlled form input. Before
  // this guard, a malformed value (bad base64, or valid base64 that isn't
  // JSON) would throw inside atob()/JSON.parse() and bubble up as an
  // unhandled 500 instead of a clean, expected 400.
  let oauthReqInfo: OAuthReqInfo;
  try {
    oauthReqInfo = JSON.parse(atob(encodedReq));
  } catch {
    return new Response("Malformed authorization request.", { status: 400 });
  }

  if (!(await constantTimeEqual(password, env.CONNECTOR_PASSWORD))) {
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
