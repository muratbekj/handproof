#!/usr/bin/env node
// The npm `bin` entry. handproof runs on Bun (it uses bun:sqlite), so this runs the built server
// with Bun whether npx (Node) or bunx (Bun) started it, and prints an install hint when there's no Bun.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const bun = process.versions.bun ? process.execPath : "bun";

const child = spawn(bun, [server, ...process.argv.slice(2)], { stdio: "inherit", detached: true });

const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwarded) {
  // Signal the whole process group, not just the direct child: when `bun` on PATH is a
  // shell-script wrapper (e.g. a pnpm global shim), the direct child is /bin/sh and the
  // real Bun server is its child — killing only the wrapper leaves the server running.
  // `detached: true` puts the child in its own group, so the launcher itself is never in it.
  process.on(signal, () => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The child is already gone, or group signalling is unavailable here:
      // fall back to signalling the direct child, as before.
      child.kill(signal);
    }
  });
}

child.on("error", (err) => {
  if (err.code === "ENOENT") {
    process.stderr.write("handproof needs Bun 1.4 or later: install it from https://bun.sh, then run this again\n");
  } else {
    process.stderr.write(`handproof: could not start Bun: ${err.message}\n`);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Die by the same signal, so whoever started us sees how the server ended.
    for (const s of forwarded) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
