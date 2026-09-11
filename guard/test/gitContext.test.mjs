import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitContext } from "../src/gitContext.mjs";

test("readGitContext on a non-repo dir → no remote (never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "norepo-"));
  try {
    const g = readGitContext(dir);
    // git resolves user.email from global config regardless of cwd, so it may be
    // set; what a non-repo dir guarantees is the absence of a remote.
    assert.equal(g.remoteUrl, null);
    assert.equal(g.remoteHost, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitContext on a real repo parses a host when a remote exists", () => {
  const g = readGitContext(process.cwd()); // run from guard/, inside the repo
  assert.ok("userEmail" in g && "remoteUrl" in g && "remoteHost" in g);
  if (g.remoteUrl) assert.ok(g.remoteHost, "remote host should parse when a remote exists");
});
