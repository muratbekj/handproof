import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config";
import { main } from "../src/bin";
import { renderBrief } from "../src/render/markdown";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import { AGENTS, initRepoHandoffs, openTestService } from "./helpers/serviceSetup";
import { captureStdoutStderr } from "./helpers/cliCapture";
import {
  OLD_UPDATED_AT,
  PRUNE_NOW,
  RECENT_UPDATED_AT,
  insertHandoffRow,
  pruneNowEnv,
  seedOldDoneWithTwoLogs,
  touchMtime,
  withPruneClock,
  writeRunLogs,
} from "./helpers/pruneSetup";
import { testEnv } from "./helpers/env";
import { tmpRepo } from "./helpers/tmpRepo";

const MCP_TOOL_NAMES = [
  "handoff_cancel",
  "handoff_claim",
  "handoff_create",
  "handoff_get",
  "handoff_list",
  "handoff_release",
  "handoff_review",
  "handoff_submit",
  "handoff_update",
  "handoff_verify",
];

function logsPrunedEvents(repo: ReturnType<typeof openTestService>["repo"], id: string) {
  return repo.events(id).filter((e) => e.type === ("logs_pruned" as typeof e.type));
}

async function runPrune(repoDir: string, argv: string[]) {
  return captureStdoutStderr(() => main(["prune", ...argv], pruneNowEnv(repoDir), repoDir));
}

describe("handoffs prune (plan acceptance 1–13)", () => {
  test("t-ac1: old done handoff with two log files", async () => {
    const repo = tmpRepo();
    try {
      const { handle, id, relPaths, paths } = seedOldDoneWithTwoLogs(repo);
      const { code, out } = await runPrune(repo.dir, []);
      expect(code).toBe(0);
      for (const rel of relPaths) {
        expect(out).toContain(`pruned  ${rel}`);
      }
      expect(out).toMatch(/pruned 2 files \([^)]+\) from 1 handoff/);
      for (const rel of relPaths) {
        expect(fs.existsSync(path.join(repo.dir, rel))).toBe(false);
      }
      expect(fs.existsSync(path.join(paths.runsDir, id))).toBe(false);
      const events = logsPrunedEvents(handle.repo, id);
      expect(events).toHaveLength(1);
      const data = events[0]?.data as { paths?: string[]; bytes?: number };
      expect(data.paths?.sort()).toEqual(relPaths.sort());
      expect(data.bytes).toBe(8);
      handle.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac2: old cancelled handoff with logs", async () => {
    const repo = tmpRepo();
    try {
      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
        const id = insertHandoffRow(handle.repo, "cancelled", OLD_UPDATED_AT, "Old cancelled for prune");
        writeRunLogs(paths.runsDir, id, ["cancel.log"]);
        handle.close();
      });
      const { code, out } = await runPrune(repo.dir, []);
      expect(code).toBe(0);
      expect(out).toMatch(/pruned 1 files/);
      expect(out).toContain("from 1 handoff");
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac3: recent done handoff (29 days) untouched", async () => {
    const repo = tmpRepo();
    try {
      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
        const id = insertHandoffRow(handle.repo, "done", RECENT_UPDATED_AT, "Recent done");
        writeRunLogs(paths.runsDir, id, ["recent.log"]);
        handle.close();
      });
      const { code, out } = await runPrune(repo.dir, []);
      expect(code).toBe(0);
      expect(out.trim()).toBe("nothing to prune");
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac4: old non-terminal handoffs with logs are untouched", async () => {
    const repo = tmpRepo();
    try {
      const statuses = ["open", "claimed", "submitted", "changes_requested", "verified"] as const;
      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
        for (const status of statuses) {
          const id = insertHandoffRow(handle.repo, status, OLD_UPDATED_AT, `Old ${status}`);
          writeRunLogs(paths.runsDir, id, [`${status}.log`]);
        }
        handle.close();
      });
      const { code, out } = await runPrune(repo.dir, []);
      expect(code).toBe(0);
      expect(out.trim()).toBe("nothing to prune");
      const reader = withPruneClock((now) => openTestService(repo, AGENTS.planner, now));
      for (const status of statuses) {
        const listed = reader.service.list({ status: [status] });
        expect(listed.ok).toBe(true);
        if (!listed.ok) continue;
        for (const h of listed.value) {
          expect(logsPrunedEvents(reader.repo, h.id)).toHaveLength(0);
          expect(fs.existsSync(path.join(reader.paths.runsDir, h.id))).toBe(true);
        }
      }
      reader.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac5: --older-than 0d prunes all done/cancelled with logs regardless of age", async () => {
    const repo = tmpRepo();
    try {
      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
        const recentId = insertHandoffRow(handle.repo, "done", RECENT_UPDATED_AT, "Recent but zero cutoff");
        writeRunLogs(paths.runsDir, recentId, ["r.log"]);
        const cancelledId = insertHandoffRow(handle.repo, "cancelled", RECENT_UPDATED_AT, "Cancelled recent");
        writeRunLogs(paths.runsDir, cancelledId, ["c.log"]);
        handle.close();
      });
      const { code, out } = await runPrune(repo.dir, ["--older-than", "0d"]);
      expect(code).toBe(0);
      expect(out).toMatch(/from 2 handoffs/);
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac6: --dry-run on case 1", async () => {
    const repo = tmpRepo();
    try {
      seedOldDoneWithTwoLogs(repo).handle.close();
      const { code, out } = await runPrune(repo.dir, ["--dry-run"]);
      expect(code).toBe(0);
      expect(out).toContain("would prune  .handoffs/runs/");
      expect(out).toMatch(/would prune 2 files/);
      const reader = withPruneClock((now) => openTestService(repo, AGENTS.planner, now));
      const done = reader.service.list({ status: ["done"] });
      expect(done.ok).toBe(true);
      if (done.ok && done.value[0]) {
        expect(logsPrunedEvents(reader.repo, done.value[0].id)).toHaveLength(0);
        expect(fs.existsSync(path.join(reader.paths.runsDir, done.value[0].id))).toBe(true);
      }
      reader.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac7: second run after successful prune", async () => {
    const repo = tmpRepo();
    try {
      const { handle, id } = seedOldDoneWithTwoLogs(repo);
      await runPrune(repo.dir, []);
      const second = await runPrune(repo.dir, []);
      expect(second.code).toBe(0);
      expect(second.out.trim()).toBe("nothing to prune");
      expect(logsPrunedEvents(handle.repo, id)).toHaveLength(1);
      handle.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac8: orphan run directories by file mtime", async () => {
    const repo = tmpRepo();
    try {
      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        openTestService(repo, { name: "human-cli", harness: "other" }, now).close();
        const oldOrphan = path.join(paths.runsDir, "h_gone");
        fs.mkdirSync(oldOrphan, { recursive: true });
        const oldFile = path.join(oldOrphan, "stale.log");
        fs.writeFileSync(oldFile, "old\n");
        touchMtime(oldFile, new Date(PRUNE_NOW.getTime() - 31 * 86_400_000));
        const mixedOrphan = path.join(paths.runsDir, "h_mixed");
        fs.mkdirSync(mixedOrphan, { recursive: true });
        const oldInMixed = path.join(mixedOrphan, "old.log");
        const newInMixed = path.join(mixedOrphan, "new.log");
        fs.writeFileSync(oldInMixed, "o\n");
        fs.writeFileSync(newInMixed, "n\n");
        touchMtime(oldInMixed, new Date(PRUNE_NOW.getTime() - 31 * 86_400_000));
        touchMtime(newInMixed, PRUNE_NOW);
      });
      await runPrune(repo.dir, []);
      expect(fs.existsSync(path.join(repo.dir, ".handoffs/runs/h_gone"))).toBe(false);
      expect(fs.existsSync(path.join(repo.dir, ".handoffs/runs/h_mixed/new.log"))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac9: symlink in run dir and stray file in runs root", async () => {
    const repo = tmpRepo();
    try {
      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        const handle = openTestService(repo, { name: "human-cli", harness: "other" }, now);
        const id = insertHandoffRow(handle.repo, "done", OLD_UPDATED_AT, "Symlink case");
        const runDir = path.join(paths.runsDir, id);
        fs.mkdirSync(runDir, { recursive: true });
        const outside = path.join(repo.dir, "outside-target.txt");
        fs.writeFileSync(outside, "keep me\n");
        const link = path.join(runDir, "escape.link");
        fs.symlinkSync(outside, link);
        fs.writeFileSync(path.join(runDir, "inside.log"), "x\n");
        const stray = path.join(paths.runsDir, "stray-root.log");
        fs.writeFileSync(stray, "stray\n");
        handle.close();
      });
      await runPrune(repo.dir, []);
      expect(fs.readFileSync(path.join(repo.dir, "outside-target.txt"), "utf8")).toBe("keep me\n");
      expect(fs.existsSync(path.join(repo.dir, ".handoffs/runs/stray-root.log"))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac10: bad --older-than values exit 2 with usage", async () => {
    const repo = tmpRepo();
    try {
      seedOldDoneWithTwoLogs(repo).handle.close();
      for (const bad of ["30", "2w", "-1d", "d", "1.5d"]) {
        const { code, err, out } = await runPrune(repo.dir, ["--older-than", bad]);
        expect(code).toBe(2);
        expect(err.toLowerCase()).toMatch(/usage|older-than/);
        expect(out).toBe("");
      }
      const reader = withPruneClock((now) => openTestService(repo, AGENTS.planner, now));
      const done = reader.service.list({ status: ["done"] });
      if (done.ok && done.value[0]) {
        expect(fs.existsSync(path.join(reader.paths.runsDir, done.value[0].id))).toBe(true);
      }
      reader.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac11: brief shows log pruned and timeline entry", async () => {
    const repo = tmpRepo();
    try {
      const { handle, id, relPaths } = seedOldDoneWithTwoLogs(repo);
      await runPrune(repo.dir, []);
      const got = handle.service.get(id);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const brief = renderBrief(got.value.handoff, got.value.events);
      expect(brief).toContain("log pruned");
      for (const rel of relPaths) {
        expect(brief).toContain(rel.split("/").pop() ?? rel);
      }
      expect(brief).toContain("logs_pruned: 2 files");

      withPruneClock((now) => {
        const paths = initRepoHandoffs(repo);
        const other = openTestService(repo, AGENTS.planner, now);
        const freshId = insertHandoffRow(other.repo, "done", RECENT_UPDATED_AT, "Still has paths");
        const { relPaths: freshLogs } = writeRunLogs(paths.runsDir, freshId, ["keep.log"]);
        const freshGot = other.service.get(freshId);
        expect(freshGot.ok).toBe(true);
        if (freshGot.ok) {
          const freshBrief = renderBrief(freshGot.value.handoff, freshGot.value.events);
          expect(freshBrief).toContain(freshLogs[0] ?? "");
          expect(freshBrief).not.toContain("log pruned");
        }
        other.close();
      });
      handle.close();
    } finally {
      repo.cleanup();
    }
  });

  test("t-ac12: MCP listTools names unchanged (no prune tool)", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoHandoffs(repo);
      const config = loadConfig(paths);
      const handle = openService({ paths, config, agent: AGENTS.planner });
      const server = createServer({ paths, config, agent: AGENTS.planner, service: handle.service });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "prune-mcp-test", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual(MCP_TOOL_NAMES);
      expect(names.some((n) => n.includes("prune"))).toBe(false);
      await client.close();
      await server.close();
      handle.close();
    } finally {
      repo.cleanup();
    }
  });
});

describe("README prune (t-ac13)", () => {
  test("README documents handoffs prune with log retention and 30-day default", () => {
    const readme = fs.readFileSync(path.join(import.meta.dir, "..", "README.md"), "utf8");
    const pruneIdx = readme.indexOf("handoffs prune");
    expect(pruneIdx).toBeGreaterThanOrEqual(0);
    const window = readme.slice(pruneIdx, pruneIdx + 400);
    expect(window.toLowerCase()).toContain("log");
    expect(window).toContain("30");
  });
});
