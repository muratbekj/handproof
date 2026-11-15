/**
 * The Bun binary running the tests. Spawn this instead of a bare `"bun"` so a
 * wrapper script named `bun` on PATH (such as a pnpm global shim) can't sit
 * between the test and the child and swallow the signals the test sends.
 */
export const BUN = process.execPath;
