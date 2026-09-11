// Interactive-prompt handshake (hook side). The hook writes a pending request into
// guard/prompt/pending/<id>.json and waits: Eridian (watching that dir) writes an
// ack quickly, then — after the user answers — a response with the action. If no ack
// arrives (Eridian isn't running), we fall back to null so the caller blocks safely.
//
// The fs/clock/sleep are injected so the orchestration is unit-testable without real
// timers or files.

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ACK_TIMEOUT_MS = 2000; // no ack by here → Eridian isn't running → fall back
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // give the user time to answer
const POLL_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} request { finding, more, payload }
 * @param {object} opts { dir, io?, clock?, sleepFn?, id? } — io/clock/sleepFn injectable
 * @returns {Promise<{action:'allow'|'block'}|null>} null = fall back (no Eridian)
 */
export async function promptForDecision(request, opts = {}) {
  const dir = opts.dir;
  const io = opts.io || defaultIo;
  const now = opts.clock || (() => Date.now());
  const nap = opts.sleepFn || sleep;
  const id = opts.id || randomUUID();

  const pending = join(dir, "pending", `${id}.json`);
  const ack = join(dir, "ack", `${id}.json`);
  const response = join(dir, "response", `${id}.json`);

  io.ensureDirs([join(dir, "pending"), join(dir, "ack"), join(dir, "response")]);
  io.write(
    pending,
    JSON.stringify({
      id,
      ts: new Date(now()).toISOString(),
      finding: request.finding,
      more: request.more || 0,
      cwd: request.payload?.cwd ?? null,
      toolName: request.payload?.tool_name ?? null,
    })
  );

  const start = now();
  let acked = false;
  try {
    while (true) {
      if (io.exists(response)) {
        const res = safeJson(io.read(response));
        return res && res.action === "allow" ? { action: "allow" } : { action: "block" };
      }
      if (!acked) {
        if (io.exists(ack)) acked = true;
        else if (now() - start > ACK_TIMEOUT_MS) return null; // no Eridian → fall back
      }
      if (now() - start > RESPONSE_TIMEOUT_MS) return { action: "block" }; // timed out → safe
      await nap(POLL_MS);
    }
  } finally {
    io.remove(pending);
    io.remove(ack);
    io.remove(response);
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const defaultIo = {
  ensureDirs: (dirs) => dirs.forEach((d) => mkdirSync(d, { recursive: true })),
  write: (p, s) => writeFileSync(p, s),
  read: (p) => readFileSync(p, "utf8"),
  exists: (p) => existsSync(p),
  remove: (p) => {
    try {
      rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  },
};
