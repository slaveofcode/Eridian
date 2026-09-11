import { test } from "node:test";
import assert from "node:assert/strict";
import { runEngine } from "../src/engine.mjs";
import { mergeConfig } from "../src/config.mjs";
import { SAMPLES } from "./samples.mjs";

const cfg = mergeConfig({});

test("Bash exposing a secret → deny + secrets finding (action block)", () => {
  const r = runEngine(
    { toolName: "Bash", toolInput: { command: `export OPENAI_API_KEY=${SAMPLES.openai}` } },
    cfg
  );
  assert.equal(r.decision, "deny");
  const f = r.findings.find((x) => x.category === "secrets");
  assert.equal(f.action, "block");
  assert.ok(r.reason.length > 0);
});

test("PII defaults to warn → allow but recorded", () => {
  const r = runEngine(
    { toolName: "Write", toolInput: { file_path: "a.txt", content: "email jane.roe@acme.io" } },
    cfg
  );
  assert.equal(r.decision, "allow");
  assert.ok(r.findings.some((f) => f.category === "pii" && f.action === "warn"));
});

test("category set to off produces no finding", () => {
  const off = mergeConfig({ actions: { secrets: "off" } });
  const r = runEngine(
    { toolName: "Bash", toolInput: { command: `export KEY=${SAMPLES.openai}` } },
    off
  );
  assert.equal(r.findings.length, 0);
  assert.equal(r.decision, "allow");
});

test("env reference is not flagged", () => {
  const r = runEngine(
    { toolName: "Bash", toolInput: { command: "export KEY=$OPENAI_API_KEY" } },
    cfg
  );
  assert.equal(r.decision, "allow");
  assert.equal(r.findings.length, 0);
});

test("commit to public repo with work email → deny", () => {
  const r = runEngine(
    {
      toolName: "Bash",
      toolInput: { command: 'git commit -m "x" && git push' },
      git: { remoteHost: "github.com", userEmail: "dev@company.com" },
    },
    mergeConfig({ denyList: { workDomains: ["company.com"] } })
  );
  assert.equal(r.decision, "deny");
  assert.ok(r.findings.some((f) => f.category === "commitIdentity"));
});

test("disabled guard → allow, no findings", () => {
  const r = runEngine(
    { toolName: "Bash", toolInput: { command: `export KEY=${SAMPLES.openai}` } },
    mergeConfig({ enabled: false })
  );
  assert.equal(r.decision, "allow");
  assert.equal(r.findings.length, 0);
});

test("oversize input is skipped (allow), flagged skipped", () => {
  const big = "x".repeat(300000);
  const r = runEngine({ toolName: "Bash", toolInput: { command: big } }, cfg);
  assert.equal(r.decision, "allow");
  assert.equal(r.skipped, true);
});
