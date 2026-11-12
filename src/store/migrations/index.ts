import { m001Init } from "./001_init.ts";
import { m002Tasks } from "./002_tasks.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Sorted, versions 1..n contiguous. Append only; never edit a shipped migration. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([m001Init, m002Tasks]);
