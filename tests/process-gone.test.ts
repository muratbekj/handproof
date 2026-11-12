import { describe, expect, test } from "bun:test";
import { processGone } from "./helpers/process";

describe("processGone", () => {
  test("a zombie (dead, not yet reaped) counts as gone", async () => {
    // sh starts `true` in the background, then execs into sleep, which never reaps it.
    const p = Bun.spawn(["sh", "-c", "true & echo $!; exec sleep 5"], { stdout: "pipe" });
    try {
      const { value } = await p.stdout.getReader().read();
      const pid = Number(new TextDecoder().decode(value).trim());
      expect(Number.isFinite(pid)).toBe(true);
      expect(await processGone(pid, 2000)).toBe(true);
    } finally {
      p.kill();
    }
  });

  test("a live process is not gone", async () => {
    const p = Bun.spawn(["sleep", "5"]);
    try {
      expect(await processGone(p.pid, 200)).toBe(false);
    } finally {
      p.kill();
    }
  });
});
