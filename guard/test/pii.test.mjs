import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPii, luhnValid } from "../src/detectors/pii.mjs";

const cats = (text, opts) => detectPii(text, opts).map((f) => f.rule);
const has = (rule, text, opts) => cats(text, opts).includes(rule);

// Append a valid Luhn check digit to a 15-digit prefix (independent of the impl).
function withCheck(prefix15) {
  const digits = prefix15.split("").map(Number);
  let sum = 0;
  // the check digit sits at the rightmost (odd) position, so doubling starts at
  // the prefix's rightmost digit
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return prefix15 + check;
}

test("luhnValid: canonical vectors", () => {
  assert.ok(luhnValid("79927398713"));
  assert.ok(!luhnValid("79927398710"));
});

test("emails detected; test domains ignored", () => {
  assert.ok(has("email", "reach me at jane.roe@acme.io please"));
  assert.ok(!has("email", "user@example.com"));
  assert.ok(!has("email", "someone@test.local"));
});

test("credit cards: valid flagged, test cards + invalid ignored", () => {
  const valid = withCheck("453201511283036"); // 16-digit Luhn-valid, not a test card
  assert.ok(has("credit-card", `card ${valid}`));
  assert.ok(!has("credit-card", "4111 1111 1111 1111")); // canonical test card
  assert.ok(!has("credit-card", "1234 5678 9012 3456")); // Luhn-invalid
});

test("US SSN detected; invalid ranges ignored", () => {
  assert.ok(has("ssn", "SSN 123-45-6789"));
  assert.ok(!has("ssn", "000-12-3456")); // area 000 invalid
  assert.ok(!has("ssn", "666-12-3456")); // area 666 invalid
});

test("phone numbers detected; 555-01xx fictional ignored", () => {
  assert.ok(has("phone", "call +1 (415) 555-2671"));
  assert.ok(!has("phone", "555-0143")); // reserved fictional range
});

test("findings are pii category, redacted", () => {
  const f = detectPii("reach me at jane.roe@acme.io")[0];
  assert.equal(f.category, "pii");
  assert.ok(!f.maskedPreview.includes("jane.roe"), "local part masked");
  assert.ok(f.maskedPreview.includes("acme.io"), "domain kept for review");
});
