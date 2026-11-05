import { HandoffsError } from "../errors.ts";

/** Last 1 MiB of combined output is kept. */
export const OUTPUT_CAP = 1_048_576;

export interface CommandOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  output: Uint8Array;
  durationMs: number;
}

function badCommand(input: string, why: string): HandoffsError {
  return new HandoffsError("bad_command", `cannot parse command '${input}': ${why}`, { command: input });
}

/**
 * Shell-like word splitting with no expansion (RESEARCH §2): whitespace separates, single quotes are
 * literal, double quotes honour \\ \" \$ \`, a backslash outside quotes keeps the next character.
 * Throws HandoffsError("bad_command") on an unbalanced quote, a trailing backslash or no words.
 */
export function splitCommand(input: string): string[] {
  const args: string[] = [];
  let cur = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  let started = false;
  while (i < input.length) {
    const c = input.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < input.length) {
        const n = input.charAt(i + 1);
        if (n === '"' || n === "\\" || n === "$" || n === "`") {
          cur += n;
          i += 2;
          continue;
        }
        if (n === "\n") {
          i += 2;
          continue;
        }
      }
      cur += c;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (started) {
        args.push(cur);
        cur = "";
        started = false;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      i++;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= input.length) throw badCommand(input, "trailing backslash");
      if (input.charAt(i + 1) === "\n") {
        i += 2;
        continue;
      }
      cur += input.charAt(i + 1);
      started = true;
      i += 2;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (quote !== null) throw badCommand(input, `unbalanced ${quote}`);
  if (started) args.push(cur);
  if (args.length === 0) throw badCommand(input, "empty command");
  return args;
}

/** Keeps the last `cap` bytes of everything pushed, in arrival order. */
function tailBuffer(cap: number): { push(data: Uint8Array): void; bytes(): Uint8Array; truncated(): boolean } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let dropped = false;
  return {
    push(data) {
      const copy = data.slice();
      chunks.push(copy);
      total += copy.byteLength;
      while (total > cap) {
        const first = chunks[0];
        if (first === undefined) break;
        dropped = true;
        const extra = total - cap;
        if (first.byteLength <= extra) {
          chunks.shift();
          total -= first.byteLength;
        } else {
          chunks[0] = first.slice(extra);
          total -= extra;
        }
      }
    },
    bytes() {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
    truncated: () => dropped,
  };
}

/**
 * Runs argv (no shell) on a PTY so stdout and stderr arrive as one chronological stream (RESEARCH §1).
 * The child leads its own process group; on timeout the whole group gets SIGKILL. Output past the
 * cap is dropped from the front; a noisy process is never killed for volume.
 * Throws when the process cannot be spawned (e.g. the binary does not exist).
 */
export async function runCommand(argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<CommandOutcome> {
  const buf = tailBuffer(OUTPUT_CAP);
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    data: (_t, data) => {
      buf.push(data);
    },
  });
  terminal.outputFlags = 0;
  const started = performance.now();
  const spawn = (): Bun.Subprocess => {
    try {
      return Bun.spawn({ cmd: argv, cwd: opts.cwd, detached: true, terminal });
    } catch (err) {
      terminal.close();
      throw err;
    }
  };
  const proc = spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, opts.timeoutMs);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    terminal.close();
  }
  // Read the fields, not the exited promise: a SIGKILL death resolves to 137 there.
  return {
    exitCode: proc.exitCode,
    signal: proc.signalCode === null ? null : String(proc.signalCode),
    timedOut,
    truncated: buf.truncated(),
    output: buf.bytes(),
    durationMs: Math.round(performance.now() - started),
  };
}
