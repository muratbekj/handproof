import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { isHandoffsError } from "./errors.ts";
import type { ServiceError } from "./service/handoffs.ts";
import { isBusy } from "./store/db.ts";

/** A service error as a JSON-RPC InternalError carrying the service code in `data` (db_busy is retryable). */
export function serviceProtocolError(err: ServiceError): ProtocolError {
  const data: Record<string, unknown> = { error: err.error };
  if (err.error === "db_busy") data.retryable = true;
  return new ProtocolError(ProtocolErrorCode.InternalError, err.message, data);
}

/** Anything a prompt or resource callback throws, mapped the same way; plain errors are logged and rethrown. */
export function thrownProtocolError(name: string, err: unknown): Error {
  if (err instanceof ProtocolError) return err;
  if (isBusy(err)) {
    return serviceProtocolError({ error: "db_busy", message: "the handoffs database is busy; retry the call" });
  }
  if (isHandoffsError(err)) return serviceProtocolError({ error: err.code, message: err.message });
  const message = err instanceof Error ? err.message : String(err);
  console.error(`handoffs: ${name} failed: ${err instanceof Error ? (err.stack ?? message) : message}`);
  return err instanceof Error ? err : new Error(message);
}
