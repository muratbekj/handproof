/**
 * A copy of process.env with every HANDOFFS_* variable removed, so tests do
 * not inherit identity or repo overrides from the shell that runs them.
 */
export function testEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.HANDOFFS_REPO;
  delete env.HANDOFFS_AGENT;
  delete env.HANDOFFS_HARNESS;
  delete env.HANDOFFS_SESSION;
  return { ...env, ...extra };
}
