import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSecrets } from "../src/detectors/secrets.mjs";
import { SAMPLES } from "./samples.mjs";

const has = (text) => detectSecrets(text).length > 0;

test("known key formats are detected", () => {
  const cases = [
    `export OPENAI_API_KEY=${SAMPLES.openai}`,
    `key: ${SAMPLES.anthropic}`,
    `aws_access_key_id = ${SAMPLES.aws}`,
    `token=${SAMPLES.github}`,
    `PAT ${SAMPLES.githubPat}`,
    `gitlab=${SAMPLES.gitlab}`,
    `google ${SAMPLES.google}`,
    `slack ${SAMPLES.slack}`,
    `stripe ${SAMPLES.stripe}`,
    "-----BEGIN RSA PRIVATE KEY-----",
  ];
  for (const c of cases) assert.ok(has(c), `should detect: ${c.slice(0, 24)}…`);
});

test("finding is redacted (no raw secret in preview)", () => {
  const f = detectSecrets(`OPENAI_API_KEY=${SAMPLES.openai}`)[0];
  assert.equal(f.category, "secrets");
  assert.equal(f.severity, "high");
  assert.ok(!f.maskedPreview.includes("abcDEF1234"), "body must be masked");
});

test("env references are NOT secrets (the correct pattern)", () => {
  assert.ok(!has("OPENAI_API_KEY = process.env.OPENAI_API_KEY"));
  assert.ok(!has("key: ${{ secrets.OPENAI }}"));
  assert.ok(!has('token = "$GITHUB_TOKEN"'));
});

test("placeholders are NOT secrets", () => {
  assert.ok(!has('api_key = "your-api-key-here"'));
  assert.ok(!has("secret: changeme"));
});

test("git sha and hex hashes are NOT secrets", () => {
  assert.ok(!has("commit = e4b16acabc1234567890abcdef1234567890abcd"));
  assert.ok(!has("checksum: 5d41402abc4b2a76b9719d911017c592"));
});

test("high-entropy value only fires in key-ish assignment context", () => {
  assert.ok(has('SESSION_SECRET = "aG7kP2qR9xZ1vB4nM6wL8tY0"'));
  // same random-looking value with a non-secret var name → not flagged
  assert.ok(!has('width = "aG7kP2qR9xZ1vB4nM6wL8tY0"'));
});

test("low-entropy / low-diversity assignment values are NOT flagged", () => {
  assert.ok(!has('token = "aaaaaaaaaaaaaaaaaaaa"')); // entropy ~0
  assert.ok(!has('password = "1111111111111111"')); // single charset class
});

test("does not double-count when a known key also matches the generic rule", () => {
  const fs = detectSecrets(`API_KEY = "${SAMPLES.openai}"`);
  assert.equal(fs.length, 1); // known-format wins; generic dedup skips the same value
});
