// Acceptance test for audit finding #1 (HIGH): allow-list bypass via path
// traversal in getFileContents (src/github.ts:109-112).
//
// `path` is interpolated unencoded into `/repos/${repo}/contents/${path}`.
// Because fetch/URL normalizes ".." segments, a path like
// "../../../../repos/other-org/private-repo/contents/.env" produces a
// request URL that targets a repo outside ALLOWED_REPOS even though
// `repo` itself passed assertRepoAllowed.
//
// This test must fail (red) against the current, unpatched getFileContents:
// today the function happily builds the traversal URL and calls fetch with
// it. After the fix (rejecting "." / ".." segments and leading "/", and
// encodeURIComponent-ing each remaining segment) it must throw before ever
// reaching fetch.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileContents, searchCode } from "./github.js";

const ALLOWED_REPO = "my-org/my-repo";

function makeEnv(): Env {
  return {
    ALLOWED_REPOS: ALLOWED_REPO,
    GITHUB_PAT: "test-pat",
    CONNECTOR_PASSWORD: "unused-in-this-test",
  } as unknown as Env;
}

describe("getFileContents path traversal (audit finding #1)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => {
      // If this ever gets called during the traversal test, the allow-list
      // has already been bypassed -- return a body that would prove it.
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: btoa("SECRET_FROM_OTHER_REPO=leaked"),
          path: ".env",
          size: 30,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("rejects a path containing '../' segments instead of escaping the allowed repo", async () => {
    const env = makeEnv();
    const traversalPath = "../../../../repos/other-org/private-repo/contents/.env";

    await expect(getFileContents(env, ALLOWED_REPO, traversalPath)).rejects.toThrow();

    // The decisive assertion: the allow-list bypass means an *unauthorized*
    // GitHub API call went out. A correct implementation must reject the
    // path before ever touching the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let a traversal path reach a URL outside the allowed repo, even if a call were made", async () => {
    const env = makeEnv();
    const traversalPath = "../../../../repos/other-org/private-repo/contents/.env";

    await expect(getFileContents(env, ALLOWED_REPO, traversalPath)).rejects.toThrow();

    for (const call of fetchMock.mock.calls) {
      const requestedUrl = String(call[0]);
      expect(requestedUrl).not.toContain("other-org/private-repo");
    }
  });

  // Regression guard: the traversal fix must not break the legitimate
  // directory-listing surface the get_file_contents tool advertises. An empty
  // path (repo root) and a trailing-slash directory path must still reach the
  // allowed repo's contents endpoint, scoped correctly and without traversal.
  it.each([
    ["", "https://api.github.com/repos/my-org/my-repo/contents/"],
    ["src/", "https://api.github.com/repos/my-org/my-repo/contents/src"],
    ["docs/roadmap.md", "https://api.github.com/repos/my-org/my-repo/contents/docs/roadmap.md"],
  ])("lists/reads a legitimate path %j against the allowed repo", async (path, expectedUrl) => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify([]), { status: 200 }));
    const env = makeEnv();

    await getFileContents(env, ALLOWED_REPO, path);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toBe(expectedUrl);
  });
});

// Acceptance test for audit finding #2 (HIGH): allow-list bypass via
// qualifier injection in searchCode (src/github.ts:124-128, current line
// numbers may have shifted after the fix).
//
// GitHub's code search combines multiple `repo:`/`org:`/`user:` qualifiers
// with OR, not AND. `query` is caller-controlled free text that gets
// concatenated with our own `repo:${repo}` qualifier. Before the fix, a
// query containing its own "repo:other-org/private-repo" qualifier would
// not be overridden by ours -- GitHub would union results from both repos,
// leaking data from a repo that was never checked against ALLOWED_REPOS.
//
// These tests must fail (red) against the unpatched searchCode: today it
// happily builds the combined query string and calls fetch with it. After
// the fix (rejecting queries containing repo:/org:/user: qualifiers) it
// must throw before ever reaching fetch.
describe("searchCode qualifier injection (audit finding #2)", () => {
  const ALLOWED_REPO = "my-org/my-repo";

  function makeEnv(): Env {
    return {
      ALLOWED_REPOS: ALLOWED_REPO,
      GITHUB_PAT: "test-pat",
      CONNECTOR_PASSWORD: "unused-in-this-test",
    } as unknown as Env;
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => {
      // If this ever gets called during a rejection test, the allow-list
      // has already been bypassed -- return a body that would prove it.
      return new Response(
        JSON.stringify({
          items: [{ path: "secrets.txt", html_url: "https://github.com/other-org/private-repo/blob/main/secrets.txt" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it.each([
    ["repo:", "leaked secret repo:other-org/private-repo"],
    ["org:", "leaked secret org:other-org"],
    ["user:", "leaked secret user:other-org"],
  ])("rejects a query containing a %s qualifier instead of letting it override the allow-list", async (_label, query) => {
    const env = makeEnv();

    await expect(searchCode(env, ALLOWED_REPO, query)).rejects.toThrow();

    // The decisive assertion: the allow-list bypass means an *unauthorized*
    // GitHub API call went out. A correct implementation must reject the
    // query before ever touching the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a benign query through and scopes it with the connector's own repo: qualifier", async () => {
    const env = makeEnv();

    await searchCode(env, ALLOWED_REPO, "TODO comments");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    // The query is URL-encoded, so decode it back out to check the
    // qualifier landed the way searchCode is supposed to build it.
    const q = new URL(requestedUrl).searchParams.get("q") || "";
    expect(q).toContain(`repo:${ALLOWED_REPO}`);
    expect(q).toContain("TODO comments");
  });
});
