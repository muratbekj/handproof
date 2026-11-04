/** Error with a stable machine-readable code. Thrown across layers; the CLI and MCP transport format it. */
export class HandoffsError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HandoffsError";
    this.code = code;
    this.details = details;
  }
}

export function isHandoffsError(err: unknown): err is HandoffsError {
  return err instanceof HandoffsError;
}
