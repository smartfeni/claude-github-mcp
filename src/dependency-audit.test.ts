// Acceptance test pinning the outcome of the npm audit remediation
// (7 advisories: 3 HIGH via wrangler -> miniflare -> sharp libvips CVEs;
// 4 MODERATE via agents -> @cloudflare/codemode ->
// @modelcontextprotocol/sdk -> @hono/node-server path traversal,
// GHSA-frvp-7c67-39w9).
//
// This test reads the *resolved* lockfile directly (package-lock.json)
// rather than re-running `npm audit` itself, so it:
//   - pins the fix into the test suite (a future `npm install` that drifts
//     the lockfile back to a vulnerable resolution re-reddens this test,
//     independent of whatever `npm audit`'s advisory database says on a
//     given day), and
//   - stays fast/offline (no registry calls), matching the existing
//     convention in this suite of exercising committed source/config
//     rather than hitting the network.
//
// CHAIN A (HIGH x3): wrangler is pinned exactly in package.json
// ("wrangler": "4.112.0"), which resolves in the lockfile to a miniflare
// version whose bundled sharp is < 0.35.0 (vulnerable to the libvips CVEs
// CVE-2026-33327 / 33328 / 35590 / 35591). wrangler@4.114.0 resolves past
// that. This assertion must fail (red) against today's lockfile, which
// resolves node_modules/wrangler to exactly "4.112.0".
//
// CHAIN B (MODERATE x4): @modelcontextprotocol/sdk@1.29.0 (the latest
// published version) depends on "@hono/node-server": "^1.19.9", which
// cannot resolve to the fixed 2.0.5+ line under semver. Today's lockfile
// resolves node_modules/@hono/node-server to "1.19.17" (vulnerable to
// GHSA-frvp-7c67-39w9, a path-traversal in serve-static via an encoded
// backslash, %5C, on Windows). This assertion must fail (red) until an
// `overrides` entry (or equivalent) forces every resolved
// @hono/node-server in the lockfile to >= 2.0.5.
//
// Both assertions are expected to fail against the current,
// pre-remediation package-lock.json.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface LockfilePackage {
  version?: string;
}

interface Lockfile {
  lockfileVersion: number;
  packages?: Record<string, LockfilePackage>;
}

function loadLockfile(): Lockfile {
  const lockfilePath = path.resolve(import.meta.dirname, "..", "package-lock.json");
  const raw = readFileSync(lockfilePath, "utf-8");
  return JSON.parse(raw) as Lockfile;
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Cannot parse semver from resolved lockfile version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Returns true if `version` >= `minVersion`, comparing as [major, minor, patch].
function isAtLeast(version: string, minVersion: string): boolean {
  const a = parseSemver(version);
  const b = parseSemver(minVersion);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe("npm audit remediation is pinned into the lockfile (dependency chains A and B)", () => {
  const lockfile = loadLockfile();
  const packages = lockfile.packages ?? {};

  it("CHAIN A: resolves wrangler to >= 4.114.0 (clears the miniflare/sharp libvips HIGH CVEs)", () => {
    const wranglerEntry = packages["node_modules/wrangler"];
    expect(wranglerEntry, "expected node_modules/wrangler to exist in package-lock.json").toBeTruthy();
    expect(wranglerEntry?.version, "package-lock.json did not record a resolved wrangler version").toBeTruthy();

    const resolvedVersion = wranglerEntry!.version!;
    expect(
      isAtLeast(resolvedVersion, "4.114.0"),
      `expected resolved wrangler >= 4.114.0, got ${resolvedVersion} (package.json still pins the ` +
        `vulnerable 4.112.0 that resolves to a miniflare/sharp with unpatched libvips CVEs)`,
    ).toBe(true);
  });

  it("CHAIN B: every resolved @hono/node-server in the lockfile is >= 2.0.5 (clears GHSA-frvp-7c67-39w9)", () => {
    const honoNodeServerEntries = Object.entries(packages).filter(([key]) =>
      /(^|\/)node_modules\/@hono\/node-server$/.test(key),
    );

    expect(
      honoNodeServerEntries.length,
      "expected at least one @hono/node-server entry in package-lock.json (dependency chain: agents -> " +
        "@cloudflare/codemode -> @modelcontextprotocol/sdk -> @hono/node-server)",
    ).toBeGreaterThan(0);

    for (const [key, entry] of honoNodeServerEntries) {
      expect(entry.version, `${key} has no resolved version recorded in package-lock.json`).toBeTruthy();
      const resolvedVersion = entry.version!;
      expect(
        isAtLeast(resolvedVersion, "2.0.5"),
        `expected ${key} resolved >= 2.0.5, got ${resolvedVersion} (vulnerable to the serve-static ` +
          "encoded-backslash path traversal on Windows, GHSA-frvp-7c67-39w9; " +
          "@modelcontextprotocol/sdk@1.29.0 alone only permits ^1.19.9, so this requires an `overrides` " +
          "entry in package.json forcing the transitive resolution to the 2.x line)",
      ).toBe(true);
    }
  });
});
