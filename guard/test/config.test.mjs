import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig, loadConfig } from "../src/config.mjs";

test("defaults have the six category actions", () => {
  assert.equal(DEFAULT_CONFIG.actions.secrets, "block");
  assert.equal(DEFAULT_CONFIG.actions.pii, "warn");
  assert.equal(DEFAULT_CONFIG.actions.aiAuthorship, "block");
});

test("mergeConfig overlays partial onto defaults (deep for actions/denyList)", () => {
  const c = mergeConfig({ actions: { pii: "block" }, denyList: { workDomains: ["x.com"] } });
  assert.equal(c.actions.pii, "block");
  assert.equal(c.actions.secrets, "block"); // untouched default kept
  assert.deepEqual(c.denyList.workDomains, ["x.com"]);
  assert.deepEqual(c.denyList.workEmails, []); // default kept
});

test("loadConfig: missing file → defaults; present file → merged", () => {
  assert.deepEqual(loadConfig("/no/such/guard.json"), DEFAULT_CONFIG);
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  try {
    const p = join(dir, "guard.json");
    writeFileSync(p, JSON.stringify({ enabled: false, actions: { dangerous: "block" } }));
    const c = loadConfig(p);
    assert.equal(c.enabled, false);
    assert.equal(c.actions.dangerous, "block");
    assert.equal(c.actions.secrets, "block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
