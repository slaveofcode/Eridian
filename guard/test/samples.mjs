// Provider-format SAMPLE tokens used ONLY to exercise the detectors. They are
// assembled at runtime from fragments so no contiguous secret-shaped literal ever
// appears in source — otherwise GitHub push protection (and other scanners) block
// the push, even though these are fake. Same reasoning as the @-literal gotcha.
const j = (...parts) => parts.join("");

export const SAMPLES = {
  openai: j("sk-", "proj-", "abcDEF1234ghiJKL5678mnoPQR"),
  anthropic: j("sk-", "ant-", "api03-abcDEF1234ghiJKL5678mnoPQRstuVWX"),
  aws: j("AKIA", "IOSFODNN7EXAMPLE"),
  github: j("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  githubPat: j("github", "_pat_", "11ABCDEFG0abcdefghij_klmnopqrstuvwx"),
  gitlab: j("glpat", "-", "abcDEF1234ghiJKL5678"),
  google: j("AIza", "SyA1234567890abcdefghijklmnopqrstuv"),
  slack: j("xox", "b-", "1234567890-abcdefghijklmnop"),
  stripe: j("sk", "_live_", "abcDEF1234ghiJKL5678mnoP"),
};
