#!/usr/bin/env bun

export async function main(_argv: string[]): Promise<number> {
  return Promise.resolve(0);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
