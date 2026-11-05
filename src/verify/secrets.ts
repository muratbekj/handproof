import type { Issue } from "../schema/errors.ts";
import { formatPath } from "../schema/errors.ts";

export type SecretPattern = "aws_access_key" | "sk_token" | "private_key" | "github_token";

export interface SecretHit {
  path: string;
  pattern: SecretPattern;
}

const PATTERNS: readonly { pattern: SecretPattern; re: RegExp }[] = [
  { pattern: "aws_access_key", re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/ },
  { pattern: "sk_token", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { pattern: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { pattern: "github_token", re: /ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
];

/** Every string inside `value` (objects and arrays walked), one hit per (path, pattern). */
export function scanSecrets(value: unknown, basePath: (string | number)[] = []): SecretHit[] {
  const hits: SecretHit[] = [];
  const walk = (v: unknown, path: (string | number)[]): void => {
    if (typeof v === "string") {
      for (const p of PATTERNS) {
        if (p.re.test(v)) hits.push({ path: formatPath(path), pattern: p.pattern });
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        walk(item, [...path, i]);
      });
    } else if (v !== null && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, [...path, k]);
    }
  };
  walk(value, basePath);
  return hits;
}

export function secretIssues(hits: SecretHit[]): Issue[] {
  return hits.map((h) => ({
    path: h.path,
    problem: `looks like an ${h.pattern}`,
    fix: "remove the secret; reference it by name instead",
  }));
}

/** The `secret_detected` error envelope, or null when nothing was found. Never echoes the secret. */
export function secretError(hits: SecretHit[]): { error: "secret_detected"; message: string; issues: Issue[] } | null {
  if (hits.length === 0) return null;
  const where = hits.map((h) => `${h.path === "" ? "(root)" : h.path} (${h.pattern})`).join(", ");
  return {
    error: "secret_detected",
    message: `refused: text looks like it contains a secret at ${where}`,
    issues: secretIssues(hits),
  };
}
