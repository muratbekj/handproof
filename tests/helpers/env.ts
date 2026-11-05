/**
 * A copy of process.env with every HANDPROOF_* variable removed, so tests do
 * not inherit identity or repo overrides from the shell that runs them.
 */
export function testEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.HANDPROOF_REPO;
  delete env.HANDPROOF_AGENT;
  delete env.HANDPROOF_HARNESS;
  delete env.HANDPROOF_SESSION;
  return { ...env, ...extra };
}
