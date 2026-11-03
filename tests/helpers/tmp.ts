import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Create a unique temporary directory for a single test. */
export function tmpDir(prefix = "handoffs-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a temporary directory (and anything below it). */
export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
