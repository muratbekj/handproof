import * as fs from "node:fs";
import { openDb } from "../../src/store/db";

const [dbPath, readyPath, goPath] = process.argv.slice(2);

if (dbPath === undefined || readyPath === undefined || goPath === undefined) {
  throw new Error("usage: dbWorker.ts <dbPath> <readyPath> <goPath>");
}

// Tell the test this process is alive, then wait until both workers are
// alive so openDb() runs at the same moment in both processes.
await Bun.write(readyPath, "ready\n");

const deadline = Date.now() + 10_000;
while (!fs.existsSync(goPath)) {
  if (Date.now() > deadline) {
    throw new Error("timed out waiting for the go file");
  }
  await Bun.sleep(5);
}

const db = openDb(dbPath);
db.close();
