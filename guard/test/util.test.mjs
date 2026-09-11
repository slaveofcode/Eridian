import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shannonEntropy,
  mask,
  looksLikeEnvRef,
  isPlaceholder,
} from "../src/util.mjs";

test("entropy: correct values + more-random scores higher", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.equal(shannonEntropy("aaaa"), 0); // one symbol → no entropy
  assert.equal(shannonEntropy("ab"), 1); // two equally likely → 1 bit
  // a diverse token scores well above a repetitive one (the property the secrets
  // detector relies on when scoring contiguous candidate tokens)
  assert.ok(
    shannonEntropy("aG7$kP2!qR9xZ1vB") > shannonEntropy("aaaaaaaaaaaaaaaa") + 3
  );
});

test("mask keeps only a short tail, hides the body", () => {
  const m = mask("sk-proj-abcdef1234");
  assert.match(m, /…1234$/);
  assert.ok(!m.includes("abcdef"), "body must be hidden");
});

test("mask handles short strings without leaking", () => {
  assert.ok(!mask("abcd").includes("abcd"));
});

test("env references are recognized (the correct pattern, never a secret)", () => {
  for (const s of [
    "$API_KEY",
    "${API_KEY}",
    "process.env.API_KEY",
    "${{ secrets.OPENAI }}",
  ]) {
    assert.ok(looksLikeEnvRef(s), `should be env ref: ${s}`);
  }
  assert.ok(!looksLikeEnvRef("sk-proj-abcdef1234"));
});

test("placeholders are recognized", () => {
  for (const s of ["your-api-key-here", "XXXX", "changeme", "example-token"]) {
    assert.ok(isPlaceholder(s), `should be placeholder: ${s}`);
  }
  assert.ok(!isPlaceholder("sk-ant-api03-realvalue"));
});
