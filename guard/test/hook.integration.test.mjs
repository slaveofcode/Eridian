import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLES } from "./samples.mjs";

const HOOK = fileURLToPath(new URL("../src/hook.mjs", import.meta.url));

function runHook(input, cfgJson) {
  const dir = mkdtempSync(join(tmpdir(), "guard-hook-"));
  const cfgPath = join(dir, "guard.json");
  writeFileSync(cfgPath, cfgJson);
  const findingsPath = join(dir, "findings.ndjson");
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: {
      ...process.env,
      ERIDIAN_GUARD_CONFIG: cfgPath,
      ERIDIAN_GUARD_FINDINGS: findingsPath,
    },
    encoding: "utf8",
  });
  let findings = "";
  try {
    findings = readFileSync(findingsPath, "utf8");
  } catch {
    /* none */
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...r, findings, cwd: dir };
}

test("blocks a secret (exit 2) and logs a redacted finding", () => {
  const r = runHook(
    {
      tool_name: "Bash",
      cwd: tmpdir(),
      session_id: "s1",
      tool_input: { command: `export OPENAI_API_KEY=${SAMPLES.openai}` },
    },
    "{}"
  );
  assert.equal(r.status, 2);
  assert.ok(r.stderr.length > 0, "reason on stderr");
  const line = JSON.parse(r.findings.trim().split("\n")[0]);
  assert.equal(line.category, "secrets");
  assert.ok(!r.findings.includes("abcDEF1234"), "no raw secret written to log");
});

test("allows a clean command (exit 0)", () => {
  const r = runHook({ tool_name: "Bash", cwd: tmpdir(), tool_input: { command: "ls -la" } }, "{}");
  assert.equal(r.status, 0);
});

test("disabled guard → allow (exit 0), even with a secret", () => {
  const r = runHook(
    { tool_name: "Bash", cwd: tmpdir(), tool_input: { command: `export K=${SAMPLES.openai}` } },
    JSON.stringify({ enabled: false })
  );
  assert.equal(r.status, 0);
});

test("malformed stdin → fail-open (exit 0)", () => {
  const r = runHook("this is not json", "{}");
  assert.equal(r.status, 0);
});
