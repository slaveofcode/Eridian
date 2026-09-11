// Commit-hygiene detectors:
//  - commitIdentity: committing/pushing to a PUBLIC repo with a work email/domain/term
//    (public-vs-private is a labeled heuristic — known public hosts minus an allowlist).
//  - aiAuthorship: a commit carrying a Claude/AI attribution (Co-Authored-By, etc.).

import { sig } from "../util.mjs";

const PUBLIC_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const maskEmail = (e) => {
  const [l, d] = String(e).split("@");
  return `${l[0]}…@${d}`;
};

const isGitCommitOp = (text) =>
  /\bgit\b[\s\S]*\b(commit|push)\b/.test(text) ||
  /git\s+config\s+user\.email/.test(text);

function isWorkEmail(email, deny) {
  const e = email.toLowerCase();
  const domain = e.split("@")[1] || "";
  if ((deny.workEmails || []).map((x) => x.toLowerCase()).includes(e)) return true;
  if ((deny.workDomains || []).map((x) => x.toLowerCase()).includes(domain)) return true;
  return false;
}

/** @returns {Array<{category,severity,rule,maskedPreview,location}>} */
export function detectCommitIdentity(text, git = {}, config = {}) {
  const s = String(text ?? "");
  if (!isGitCommitOp(s)) return [];
  const deny = config.denyList || {};
  const privateRemotes = config.privateRemotes || [];
  const host = git.remoteHost || null;
  const publicRemote =
    !!host && PUBLIC_HOSTS.has(host) && !privateRemotes.includes(host);
  if (!publicRemote) return []; // heuristic: only flag on a known public remote

  const candidates = new Set();
  for (const m of s.matchAll(EMAIL_G)) candidates.add(m[0]);
  if (git.userEmail) candidates.add(git.userEmail);

  const workTerms = (deny.workTerms || []).map((t) => t.toLowerCase()).filter(Boolean);
  for (const email of candidates) {
    const hit =
      isWorkEmail(email, deny) ||
      workTerms.some((t) => email.toLowerCase().includes(t));
    if (hit) {
      return [
        {
          category: "commitIdentity",
          severity: "high",
          rule: "work-email-public-repo",
          maskedPreview: maskEmail(email),
          location: host,
          sig: sig(email),
        },
      ];
    }
  }
  return [];
}

const AI_PATTERNS = [
  /Co-?Authored-By:\s*.*(claude|anthropic)/i,
  /Generated with .{0,20}Claude Code/i,
  /noreply@anthropic/i,
  /--author=["'][^"']*claude/i,
];

/** @returns {Array<{category,severity,rule,maskedPreview,location}>} */
export function detectAiAuthorship(text) {
  const s = String(text ?? "");
  if (!AI_PATTERNS.some((re) => re.test(s))) return [];
  return [
    {
      category: "aiAuthorship",
      severity: "high",
      rule: "ai-commit-attribution",
      maskedPreview: "AI authorship marker",
      location: null,
      sig: sig("ai-commit-attribution"),
    },
  ];
}
