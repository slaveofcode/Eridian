#!/usr/bin/env node
// Claude Code PreToolUse hook (block path). Reads the payload on stdin, runs the
// engine, appends redacted findings, and BLOCKS via exit code 2 + a stderr reason
// (the stable, version-independent PreToolUse mechanism). Fail-open: any error or a
// disabled/oversize case exits 0 (allow) so a guard bug never wedges coding.
//
// `decide()` is the pure core (unit-tested); `main()` does the IO (integration-tested).

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { runEngine } from "./engine.mjs";
import { readGitContext } from "./gitContext.mjs";
import { applyRememberedDecisions } from "./decisions.mjs";
import { promptForDecision } from "./prompt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH =
  process.env.ERIDIAN_GUARD_CONFIG || join(HERE, "..", "guard.json");
const FINDINGS_PATH =
  process.env.ERIDIAN_GUARD_FINDINGS || join(HERE, "..", "findings.ndjson");
const PROMPT_DIR = process.env.ERIDIAN_GUARD_PROMPT || join(HERE, "..", "prompt");

/**
 * Pure decision core. Returns the decision + the enriched, redacted findings to log.
 * @param {object} payload the PreToolUse stdin payload
 * @param {object} config merged guard config
 * @param {{gitContext?:object, idFn?:Function, now?:Function}} opts
 */
export async function decide(payload, config, opts = {}) {
  if (!config.enabled) return { decision: "allow", reason: "", findings: [] };
  const input = {
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    cwd: payload.cwd,
    git: opts.gitContext || {},
  };
  const r = runEngine(input, config);
  const id = opts.idFn || randomUUID;
  const now = opts.now || (() => new Date().toISOString());
  const enriched = r.findings.map((f) => ({
    id: id(),
    ts: now(),
    sessionId: payload.session_id ?? null,
    cwd: payload.cwd ?? null,
    toolName: payload.tool_name ?? null,
    ...f,
  }));

  // Auto-apply remembered decisions: allowed patterns drop, blocked patterns stay
  // (silent), the rest need a decision.
  const { kept, blockUnresolved } = applyRememberedDecisions(
    enriched,
    config.decisions || []
  );
  let decision = kept.some((f) => f.action === "block") ? "deny" : "allow";

  // Interactive mode: pause the tool and ask, unless nothing is unresolved.
  if (config.promptOnCatch && blockUnresolved.length > 0 && opts.prompt) {
    const res = await opts.prompt({
      finding: blockUnresolved[0],
      more: blockUnresolved.length - 1,
      payload,
    });
    decision = res && res.action === "allow" ? "allow" : "deny";
  }

  const reason =
    decision === "deny"
      ? `Eridian guard blocked this: ${kept
          .filter((f) => f.action === "block")
          .map((f) => `${f.category} (${f.rule}) — ${f.maskedPreview}`)
          .join("; ")}. Use env vars / remove the sensitive value and retry.`
      : "";

  return { decision, reason, findings: kept, skipped: r.skipped };
}

function appendFindings(findings, path = FINDINGS_PATH) {
  if (!findings.length) return;
  const lines = findings.map((f) => JSON.stringify(f)).join("\n") + "\n";
  appendFileSync(path, lines);
}

async function main() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    process.exit(0); // no stdin → allow
  }

  if (process.argv.includes("--scan")) {
    // Batch scan mode for Eridian: treat the input as a Bash-like blob.
    const config = safe(() => loadConfig(CONFIG_PATH), {});
    const out = await decide(
      { tool_name: "Bash", tool_input: { text: raw } },
      config,
      {}
    ).catch(() => ({ findings: [] }));
    process.stdout.write(JSON.stringify(out.findings));
    process.exit(0);
  }

  const payload = safe(() => JSON.parse(raw || "{}"), null);
  if (!payload) process.exit(0);
  const config = safe(() => loadConfig(CONFIG_PATH), null);
  if (!config) process.exit(0);

  // In interactive mode, hand the hook a prompt fn that runs the Eridian handshake.
  const promptFn = config.promptOnCatch
    ? (req) => promptForDecision(req, { dir: PROMPT_DIR })
    : undefined;

  let out;
  try {
    out = await decide(payload, config, {
      gitContext: readGitContext(payload.cwd || process.cwd()),
      prompt: promptFn,
    });
  } catch (e) {
    // fail-open, but record the gap so Eridian can surface it
    safe(() =>
      appendFindings([
        {
          id: randomUUID(),
          ts: new Date().toISOString(),
          sessionId: payload.session_id ?? null,
          cwd: payload.cwd ?? null,
          category: "guard-error",
          severity: "low",
          action: "warn",
          rule: "guard-error",
          maskedPreview: String(e && e.message).slice(0, 120),
          location: null,
        },
      ])
    );
    process.exit(0);
  }

  safe(() => appendFindings(out.findings));
  if (out.decision === "deny") {
    process.stderr.write((out.reason || "Blocked by Eridian guard.") + "\n");
    process.exit(2);
  }
  process.exit(0);
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => process.exit(0)); // fail-open on any unexpected async error
}
