import { test } from "node:test";
import assert from "node:assert/strict";
import { promptForDecision } from "../src/prompt.mjs";

// Fake fs where ack/response "appear" once the injected clock passes a threshold.
function makeIo(appearsAt, content, clockRef) {
  const store = new Map();
  const scheduled = (p) => {
    if (p.includes("/ack/") && appearsAt.ack != null) return clockRef.t >= appearsAt.ack;
    if (p.includes("/response/") && appearsAt.response != null)
      return clockRef.t >= appearsAt.response;
    return false;
  };
  return {
    ensureDirs: () => {},
    write: (p, s) => store.set(p, s),
    remove: (p) => store.delete(p),
    exists: (p) => store.has(p) || scheduled(p),
    read: (p) =>
      store.get(p) ?? (p.includes("/response/") ? content.response ?? "" : ""),
  };
}

function run(appearsAt, content, stepMs = 120) {
  const clockRef = { t: 0 };
  return promptForDecision(
    { finding: { category: "secrets", rule: "openai", sig: "abc" }, payload: { cwd: "/x" } },
    {
      dir: "/g",
      id: "t1",
      io: makeIo(appearsAt, content, clockRef),
      clock: () => clockRef.t,
      sleepFn: async () => {
        clockRef.t += stepMs;
      },
    }
  );
}

test("no ack (Eridian not running) → null fallback", async () => {
  assert.equal(await run({}, {}), null);
});

test("ack then allow response → allow", async () => {
  const r = await run({ ack: 120, response: 360 }, { response: '{"action":"allow"}' });
  assert.deepEqual(r, { action: "allow" });
});

test("ack then block response → block", async () => {
  const r = await run({ ack: 120, response: 360 }, { response: '{"action":"block"}' });
  assert.deepEqual(r, { action: "block" });
});

test("ack but no response before the response timeout → block (safe)", async () => {
  // big steps so we cross the 5-min response timeout quickly
  const r = await run({ ack: 120 }, {}, 60000);
  assert.deepEqual(r, { action: "block" });
});
