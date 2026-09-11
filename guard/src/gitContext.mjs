// Git context for the commit-hygiene detectors. `parseRemoteHost` is pure (unit
// tested); `readGitContext` shells out read-only and returns nulls on any failure.

import { execFileSync } from "node:child_process";

/** Extract the host from an ssh (`git@host:path`) or url (`scheme://host/…`) remote. */
export function parseRemoteHost(url) {
  const u = String(url ?? "").trim();
  if (!u) return null;
  let m = u.match(/^[\w.-]+@([\w.-]+):/); // scp-like ssh
  if (m) return m[1];
  m = u.match(/^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?([\w.-]+)/i); // url
  if (m) return m[1];
  return null;
}

/** Read the repo's configured email + origin remote for `cwd`. Read-only; never
 *  throws — a non-repo dir or missing git yields all-null. */
export function readGitContext(cwd) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 500,
      }).trim();
    } catch {
      return "";
    }
  };
  const userEmail = run(["config", "user.email"]) || null;
  const remoteUrl = run(["remote", "get-url", "origin"]) || null;
  return {
    userEmail,
    remoteUrl,
    remoteHost: remoteUrl ? parseRemoteHost(remoteUrl) : null,
  };
}
