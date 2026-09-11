import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide } from "../src/hook.mjs";
import { mergeConfig } from "../src/config.mjs";
import { SAMPLES } from "./samples.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pretooluse.json", import.meta.url), "utf8")
);
const cfg = mergeConfig({});
const det = { idFn: () => "id1", now: () => "2026-01-01T00:00:00Z" };

test("decide: clean payload → allow, no findings", async () => {
  const out = await decide(fixture, cfg, det);
  assert.equal(out.decision, "allow");
  assert.equal(out.findings.length, 0);
});

test("decide: secret payload → deny + enriched, redacted finding", async () => {
  const p = {
    ...fixture,
    tool_input: { command: `export OPENAI_API_KEY=${SAMPLES.openai}` },
  };
  const out = await decide(p, cfg, det);
  assert.equal(out.decision, "deny");
  assert.ok(out.reason.length > 0);
  const f = out.findings[0];
  assert.equal(f.id, "id1");
  assert.equal(f.ts, "2026-01-01T00:00:00Z");
  assert.equal(f.sessionId, fixture.session_id);
  assert.equal(f.category, "secrets");
  assert.equal(f.action, "block");
  assert.ok(!JSON.stringify(f).includes("abcDEF1234"), "no raw secret in finding");
});

test("decide: disabled config → allow", async () => {
  const out = await decide(fixture, mergeConfig({ enabled: false }), det);
  assert.equal(out.decision, "allow");
  assert.equal(out.findings.length, 0);
});

test("decide: remembered-allow drops the block (allow, not kept)", async () => {
  const p = { ...fixture, tool_input: { command: `export OPENAI_API_KEY=${SAMPLES.openai}` } };
  const base = await decide(p, cfg, det);
  const secret = base.findings.find((f) => f.category === "secrets");
  const remembered = mergeConfig({
    decisions: [{ scope: "exact", key: secret.sig, action: "allow" }],
  });
  const out = await decide(p, remembered, det);
  assert.equal(out.decision, "allow");
  assert.ok(!out.findings.some((f) => f.category === "secrets"));
});

test("decide: promptOnCatch asks and follows the answer", async () => {
  const p = { ...fixture, tool_input: { command: `export OPENAI_API_KEY=${SAMPLES.openai}` } };
  const cfgP = mergeConfig({ promptOnCatch: true });
  const allowed = await decide(p, cfgP, { ...det, prompt: async () => ({ action: "allow" }) });
  assert.equal(allowed.decision, "allow");
  const blocked = await decide(p, cfgP, { ...det, prompt: async () => ({ action: "block" }) });
  assert.equal(blocked.decision, "deny");
});
