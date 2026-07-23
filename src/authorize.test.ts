// Acceptance tests for audit findings #3, #4, and #5 in src/authorize.ts.

import { describe, expect, it, vi } from "vitest";
import { constantTimeEqual, handleAuthorizePost, renderForm } from "./authorize.js";

// -----------------------------------------------------------------------
// Finding #3 (MEDIUM): reflected XSS in the authorize page (renderForm,
// `<h1>Authorize ${clientName}</h1>`). `clientName` comes from
// `lookupClient`, and dynamic client registration is open (`/register` in
// src/index.ts), so an attacker can register a client whose name is a
// script tag and have it reflected unescaped into the page.
//
// This test must fail (red) against the unpatched renderForm: today
// clientName is interpolated as-is, so the literal string "<script>" ends
// up in the HTML output verbatim.
// -----------------------------------------------------------------------
describe("renderForm HTML-escapes clientName (audit finding #3)", () => {
  it("escapes a malicious clientName instead of reflecting it verbatim", () => {
    const html = renderForm({
      clientName: "<script>alert(1)</script>",
      encodedReq: "abc123",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersands first so entities aren't double-escaped", () => {
    const html = renderForm({
      clientName: "Tom & Jerry's \"App\"",
      encodedReq: "abc123",
    });

    expect(html).toContain("Tom &amp; Jerry&#39;s &quot;App&quot;");
    // No raw quote/apostrophe/angle-bracket characters from clientName
    // should survive into the <h1>.
    expect(html).not.toContain("<h1>Authorize Tom & Jerry's \"App\"</h1>");
  });
});

// -----------------------------------------------------------------------
// Finding #4 (LOW): non-constant-time password comparison
// (`password !== env.CONNECTOR_PASSWORD`). Replaced with `constantTimeEqual`,
// which hashes both sides with SHA-256 before comparing so the comparison
// never depends on where the strings first differ or on their raw lengths.
//
// These tests must fail (red) against a version of authorize.ts that has no
// exported `constantTimeEqual` helper (the unpatched code inlines a plain
// `!==` string comparison with nothing importable to exercise).
// -----------------------------------------------------------------------
describe("constantTimeEqual password comparison (audit finding #4)", () => {
  it("returns true for equal strings", async () => {
    await expect(constantTimeEqual("correct-horse", "correct-horse")).resolves.toBe(true);
  });

  it("returns false for unequal strings of the same length", async () => {
    await expect(constantTimeEqual("correct-horse", "correct-mouse")).resolves.toBe(false);
  });

  it("returns false for unequal strings of different lengths without throwing", async () => {
    await expect(constantTimeEqual("short", "a-much-longer-password")).resolves.toBe(false);
  });

  it("returns false for an empty guess against a non-empty password", async () => {
    await expect(constantTimeEqual("", "correct-horse")).resolves.toBe(false);
  });
});

// -----------------------------------------------------------------------
// Finding #5 (LOW): unguarded `JSON.parse(atob(encodedReq))` in
// handleAuthorizePost. A malformed `oauthReq` field (bad base64, or valid
// base64 that isn't JSON) used to throw inside atob()/JSON.parse() and
// surface as an unhandled 500 instead of a clean 400.
//
// This test must fail (red) against the unpatched handler: it throws
// synchronously instead of returning a Response, so `await
// handleAuthorizePost(...)` rejects rather than resolving to a 400.
// -----------------------------------------------------------------------
describe("handleAuthorizePost guards malformed oauthReq (audit finding #5)", () => {
  function makeEnv() {
    return {
      CONNECTOR_PASSWORD: "unused-in-this-test",
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn(),
        lookupClient: vi.fn(async () => ({ clientId: "c1", clientName: "Claude" })),
        completeAuthorization: vi.fn(),
      },
    } as unknown as Env & { OAUTH_PROVIDER: any };
  }

  it("returns 400 for a non-base64 oauthReq instead of throwing", async () => {
    const env = makeEnv();
    const form = new URLSearchParams();
    form.set("password", "whatever");
    form.set("oauthReq", "not-valid-base64-$$$");
    const request = new Request("https://example.com/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const response = await handleAuthorizePost(request, env);

    expect(response.status).toBe(400);
  });

  it("returns 400 for valid base64 that isn't JSON instead of throwing", async () => {
    const env = makeEnv();
    const form = new URLSearchParams();
    form.set("password", "whatever");
    form.set("oauthReq", btoa("this is not json"));
    const request = new Request("https://example.com/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const response = await handleAuthorizePost(request, env);

    expect(response.status).toBe(400);
  });
});
