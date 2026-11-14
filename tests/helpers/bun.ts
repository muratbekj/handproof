/**
 * The Bun binary that is running the tests.
 *
 * WHY: spawning a bare `"bun"` resolves through PATH. If that `bun` is a
 * shell-script wrapper (for example the shim a pnpm global install creates),
 * signals sent to the child reach the wrapper instead of Bun, which breaks
 * signal-sensitive tests. `process.execPath` is always the real binary.
 */
export const BUN = process.execPath;
