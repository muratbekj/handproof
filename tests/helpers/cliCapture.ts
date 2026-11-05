export async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "object" && value !== null) {
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/** Captures process.stderr.write and console.error (matches CLI printError / usageError). */
export async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origConsole = console.error;
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  console.error = (...args: unknown[]): void => {
    chunks.push(`${args.map(formatArg).join(" ")}\n`);
  };
  try {
    const result = await fn();
    return { result, stderr: chunks.join("") };
  } finally {
    process.stderr.write = origErr;
    console.error = origConsole;
  }
}

export async function captureStdoutStderr(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}
