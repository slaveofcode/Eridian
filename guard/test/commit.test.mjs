import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteHost } from "../src/gitContext.mjs";
import {
  detectCommitIdentity,
  detectAiAuthorship,
} from "../src/detectors/commit.mjs";

test("parseRemoteHost handles ssh + https remotes", () => {
  assert.equal(parseRemoteHost("git@github.com:org/repo.git"), "github.com");
  assert.equal(parseRemoteHost("https://github.com/org/repo.git"), "github.com");
  assert.equal(parseRemoteHost("https://gitlab.company.com/x/y"), "gitlab.company.com");
  assert.equal(parseRemoteHost(""), null);
});

const CFG = { denyList: { workDomains: ["company.com"], workEmails: [], workTerms: [] }, privateRemotes: [] };

test("commit-identity fires: work email + public remote", () => {
  const git = { remoteHost: "github.com", userEmail: "dev@company.com" };
  const f = detectCommitIdentity('git commit -m "x"', git, CFG);
  assert.equal(f.length, 1);
  assert.equal(f[0].category, "commitIdentity");
  assert.ok(!f[0].maskedPreview.includes("dev"), "email masked");
});

test("commit-identity fires via explicit --author on public remote", () => {
  const git = { remoteHost: "github.com", userEmail: "me@personal.com" };
  const f = detectCommitIdentity(
    'git commit --author="Dev <dev@company.com>" -m "x"',
    git,
    CFG
  );
  assert.equal(f.length, 1);
});

test("commit-identity does NOT fire on private/unknown remote", () => {
  const priv = { remoteHost: "git.internal.company", userEmail: "dev@company.com" };
  assert.equal(detectCommitIdentity('git commit -m "x"', priv, CFG).length, 0);
  const allow = { remoteHost: "github.com", userEmail: "dev@company.com" };
  const cfg2 = { ...CFG, privateRemotes: ["github.com"] };
  assert.equal(detectCommitIdentity('git commit -m "x"', allow, cfg2).length, 0);
});

test("commit-identity does NOT fire for a non-work email", () => {
  const git = { remoteHost: "github.com", userEmail: "me@personal.com" };
  assert.equal(detectCommitIdentity('git commit -m "x"', git, CFG).length, 0);
});

test("commit-identity fires via exact work email and via work term", () => {
  const git = { remoteHost: "github.com", userEmail: "ceo@corp.example" };
  const byEmail = { denyList: { workEmails: ["ceo@corp.example"], workDomains: [], workTerms: [] }, privateRemotes: [] };
  assert.equal(detectCommitIdentity('git commit -m "x"', git, byEmail).length, 1);
  const byTerm = { denyList: { workEmails: [], workDomains: [], workTerms: ["corp"] }, privateRemotes: [] };
  assert.equal(detectCommitIdentity('git commit -m "x"', git, byTerm).length, 1);
});

test("commit-identity: public remote but no candidate email → no fire", () => {
  const git = { remoteHost: "github.com", userEmail: null };
  assert.equal(detectCommitIdentity('git commit -m "x"', git, CFG).length, 0);
});

test("commit-identity: non-git command → no fire", () => {
  const git = { remoteHost: "github.com", userEmail: "dev@company.com" };
  assert.equal(detectCommitIdentity('echo dev@company.com', git, CFG).length, 0);
});

test("ai-authorship: Co-Authored-By Claude / Generated with Claude Code", () => {
  assert.equal(
    detectAiAuthorship('git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"')
      .length,
    1
  );
  assert.equal(detectAiAuthorship("🤖 Generated with Claude Code").length, 1);
  assert.equal(detectAiAuthorship('git commit -m "feat: normal change"').length, 0);
});
