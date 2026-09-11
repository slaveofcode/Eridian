// PII detector: emails, credit cards (Luhn-validated), US SSN, phone numbers.
// Context-heavy, so defaults to Warn (the engine stamps the action). Test/fake data
// (example.com, canonical test cards, 555-01xx, invalid SSN ranges) is ignored.

import { sig } from "../util.mjs";

/** Luhn checksum validation over a digit string. */
export function luhnValid(numStr) {
  const digits = String(numStr).replace(/\D/g, "");
  if (digits.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const TEST_CARDS = new Set([
  "4111111111111111",
  "4242424242424242",
  "5555555555554444",
  "5105105105105100",
  "378282246310005",
  "371449635398431",
  "6011111111111117",
  "6011000990139424",
  "3530111333300000",
  "3566002020360505",
  "30569309025904",
  "38520000023237",
]);

const IGNORED_EMAIL_DOMAIN =
  /(?:^|@)(?:.*\.)?(?:example\.(?:com|org|net)|test|local|localhost|invalid)$/i;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const PHONE =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g;

const maskTail = (s, n = 4) => `…${String(s).replace(/\s/g, "").slice(-n)}`;

function maskEmail(email) {
  const [local, domain] = email.split("@");
  return `${local[0]}…@${domain}`;
}

/** @returns {Array<{category,severity,rule,maskedPreview,location}>} */
export function detectPii(text) {
  const s = String(text ?? "");
  const findings = [];
  const push = (rule, maskedPreview, raw) =>
    findings.push({
      category: "pii",
      severity: "medium",
      rule,
      maskedPreview,
      location: null,
      sig: sig(raw),
    });

  for (const m of s.matchAll(EMAIL)) {
    if (IGNORED_EMAIL_DOMAIN.test(m[0].split("@")[1])) continue;
    push("email", maskEmail(m[0]), m[0]);
  }

  for (const m of s.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (TEST_CARDS.has(digits)) continue;
    if (!luhnValid(digits)) continue;
    push("credit-card", maskTail(digits), digits);
  }

  for (const m of s.matchAll(SSN)) {
    const area = Number(m[1]);
    if (area === 0 || area === 666 || area >= 900) continue;
    if (Number(m[2]) === 0 || Number(m[3]) === 0) continue;
    push("ssn", `…-…-${m[3]}`, m[0]);
  }

  for (const m of s.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10) continue;
    if (/55501\d\d/.test(digits)) continue; // 555-01xx reserved/fictional
    push("phone", maskTail(digits), digits);
  }

  return findings;
}
