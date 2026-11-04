import { m001Init } from "./001_init.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Sorted, versions 1..n contiguous. Append only; never edit a shipped migration. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([m001Init]);
