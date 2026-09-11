# eridian-guard

Deterministic security-detection engine for agentic coding, and the Claude Code
`PreToolUse` hook that can block on it. Zero runtime dependencies (uses `node:test`
and `node:crypto` only).

- Detectors: secrets/API keys, PII, exfiltration, dangerous commands,
  commit-identity leak, AI-authorship leak.
- Modes: `hook` (stdin `PreToolUse` payload → allow/deny) and `scan` (batch text →
  findings) for Eridian's review.
- Run tests: `node --test` · Coverage: `node --test --experimental-test-coverage`.

Eridian bundles this directory as a Tauri resource and copies it into its own
app-data dir at runtime; the `~/.claude` hook entry points at that copy. Findings are
written **redacted** (masked previews only) to `findings.ndjson`, which Eridian tails.

See `docs/superpowers/specs/2026-08-13-security-guard-design.md`.
