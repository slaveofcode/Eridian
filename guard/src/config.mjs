// Guard configuration: defaults + tolerant loader. Eridian is the sole writer of
// guard.json; the hook only reads it (this module).

import { readFileSync } from "node:fs";

export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  strictFailClosed: false,
  promptOnCatch: false,
  sizeCap: 262144,
  decisions: [], // remembered: { scope: "exact"|"rule", key, action: "allow"|"block" }
  actions: {
    secrets: "block",
    pii: "warn",
    exfiltration: "block",
    dangerous: "warn",
    commitIdentity: "block",
    aiAuthorship: "block",
  },
  denyList: { workEmails: [], workDomains: [], workTerms: [] },
  privateRemotes: [],
  allowlists: { paths: [], patterns: [] },
};

/** Overlay a partial config onto the defaults (deep for the nested objects). */
export function mergeConfig(partial) {
  const p = partial && typeof partial === "object" ? partial : {};
  return {
    ...DEFAULT_CONFIG,
    ...p,
    actions: { ...DEFAULT_CONFIG.actions, ...(p.actions || {}) },
    denyList: { ...DEFAULT_CONFIG.denyList, ...(p.denyList || {}) },
    allowlists: { ...DEFAULT_CONFIG.allowlists, ...(p.allowlists || {}) },
    privateRemotes: p.privateRemotes || DEFAULT_CONFIG.privateRemotes,
  };
}

/** Read + merge guard.json; a missing/unparseable file yields the defaults. */
export function loadConfig(path) {
  try {
    return mergeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
