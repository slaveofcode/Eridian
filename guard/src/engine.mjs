// Engine: compose the detectors over a tool call, stamp each finding's action from
// config, and compute the allow/deny decision. Single source of truth shared by the
// hook (block path) and Eridian's scan (review path).

import { detectSecrets } from "./detectors/secrets.mjs";
import { detectPii } from "./detectors/pii.mjs";
import { detectExfil } from "./detectors/exfil.mjs";
import { detectDangerous } from "./detectors/dangerous.mjs";
import { detectCommitIdentity, detectAiAuthorship } from "./detectors/commit.mjs";

const CONTENT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Collect all string values from the tool input into one scannable blob. */
function extractText(toolInput) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(toolInput);
  return out.join("\n");
}

/**
 * @param {{toolName:string, toolInput:any, cwd?:string, git?:object}} input
 * @param {object} config merged config (see config.mjs)
 * @returns {{findings:Array, decision:'allow'|'deny', reason:string, skipped?:boolean}}
 */
export function runEngine(input, config) {
  if (!config.enabled) return { findings: [], decision: "allow", reason: "" };
  const text = extractText(input.toolInput);
  if (text.length > config.sizeCap) {
    return { findings: [], decision: "allow", reason: "", skipped: true };
  }

  const tool = input.toolName;
  const raw = [];
  if (tool === "Bash") {
    raw.push(...detectSecrets(text));
    raw.push(...detectPii(text));
    raw.push(...detectDangerous(text));
    raw.push(...detectCommitIdentity(text, input.git || {}, config));
    raw.push(...detectAiAuthorship(text));
    raw.push(...detectExfil(text, raw.slice())); // exfil sees the secrets/pii found here
  } else if (CONTENT_TOOLS.has(tool)) {
    raw.push(...detectSecrets(text));
    raw.push(...detectPii(text));
    raw.push(...detectExfil(text, raw.slice()));
  } else {
    raw.push(...detectSecrets(text));
    raw.push(...detectPii(text));
  }

  const findings = [];
  for (const f of raw) {
    const action = config.actions[f.category] || "off";
    if (action === "off") continue;
    findings.push({ ...f, action });
  }

  const blocking = findings.filter((f) => f.action === "block");
  const decision = blocking.length > 0 ? "deny" : "allow";
  const reason =
    decision === "deny"
      ? `Eridian guard blocked this: ${blocking
          .map((f) => `${f.category} (${f.rule}) — ${f.maskedPreview}`)
          .join("; ")}. Use env vars / remove the sensitive value and retry.`
      : "";

  return { findings, decision, reason };
}
