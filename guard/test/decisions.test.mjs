import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decisionKeys,
  matchDecision,
  applyRememberedDecisions,
} from "../src/decisions.mjs";

const f = { category: "secrets", rule: "openai", sig: "deadbeefcafef00d" };

test("decisionKeys exposes exact (sig) and rule keys", () => {
  const k = decisionKeys(f);
  assert.equal(k.exact, "deadbeefcafef00d");
  assert.equal(k.rule, "secrets:openai");
});

test("no remembered decision → null", () => {
  assert.equal(matchDecision(f, []), null);
  assert.equal(matchDecision(f, [{ scope: "exact", key: "other", action: "allow" }]), null);
});

test("exact-match decision applies", () => {
  assert.equal(
    matchDecision(f, [{ scope: "exact", key: "deadbeefcafef00d", action: "allow" }]),
    "allow"
  );
});

test("rule-scope decision applies to any finding of that rule", () => {
  const other = { category: "secrets", rule: "openai", sig: "1111" };
  assert.equal(
    matchDecision(other, [{ scope: "rule", key: "secrets:openai", action: "block" }]),
    "block"
  );
});

test("exact wins over rule; block wins over allow at same scope", () => {
  assert.equal(
    matchDecision(f, [
      { scope: "rule", key: "secrets:openai", action: "block" },
      { scope: "exact", key: "deadbeefcafef00d", action: "allow" },
    ]),
    "allow" // exact beats rule
  );
  assert.equal(
    matchDecision(f, [
      { scope: "exact", key: "deadbeefcafef00d", action: "allow" },
      { scope: "exact", key: "deadbeefcafef00d", action: "block" },
    ]),
    "block" // safer wins within a scope
  );
});

test("applyRememberedDecisions: drop allowed, keep blocked/warn, list unresolved", () => {
  const findings = [
    { category: "secrets", rule: "openai", sig: "aaaa", action: "block" }, // allowed → drop
    { category: "secrets", rule: "aws", sig: "bbbb", action: "block" }, // remembered block → keep, no prompt
    { category: "exfiltration", rule: "x", sig: "cccc", action: "block" }, // no memory → keep + unresolved
    { category: "pii", rule: "email", sig: "dddd", action: "warn" }, // warn → keep
  ];
  const decisions = [
    { scope: "exact", key: "aaaa", action: "allow" },
    { scope: "exact", key: "bbbb", action: "block" },
  ];
  const { kept, blockUnresolved } = applyRememberedDecisions(findings, decisions);
  assert.deepEqual(kept.map((f) => f.sig), ["bbbb", "cccc", "dddd"]);
  assert.deepEqual(blockUnresolved.map((f) => f.sig), ["cccc"]);
});
