/**
 * True once `pid` is dead: no such process, or a zombie (exited, not yet reaped).
 * `process.kill(pid, 0)` alone can't tell: it succeeds on a zombie, and an orphan killed with its
 * process group is reaped by init asynchronously. Polls every 20 ms for up to `timeoutMs`.
 */
export async function processGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isGoneNow(pid)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
}

function isGoneNow(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true; // ESRCH: no such process
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat === "" || stat.startsWith("Z");
}
