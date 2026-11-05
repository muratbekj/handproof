import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config";
import { Handoff } from "../src/schema/handoff";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import { PREEXISTING_MAX, changedFiles, snapshotDirty } from "../src/verify/scope";
import fullHandoffFixture from "./fixtures/handoffs/full-handoff.json";
import {
  criteriaFor,
  implementHandoffInput,
  withPhase2Clock,
} from "./helpers/phase2Setup";
import { initRepoWithPreexistingDirty } from "./helpers/phase3Setup";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";

const SUMMARY =
  "Implemented login under src/auth only; pre-existing dirty files left untouched.";

/** DEMO_CONFIG only defines `test`; default implementHandoffInput uses `okfile`. */
function step1HandoffInput() {
  return implementHandoffInput([
    { id: "ac1", description: "Auth ok file exists and scope is respected.", check: "test" },
  ]);
}

function structured(call: { content: unknown[]; structuredContent?: unknown; isError?: boolean }) {
  const textBlock = call.content.find(
    (c) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  const text = textBlock?.text;
  if (text === undefined) throw new Error("missing text block");
  expect(JSON.parse(text)).toEqual(call.structuredContent);
  return call.structuredContent as Record<string, unknown>;
}

describe("snapshotDirty and PREEXISTING_MAX (PLAN Step 1)", () => {
  test("snapshotDirty lists dirty tracked and untracked paths sorted", () => {
    const repo = tmpRepo();
    try {
      fs.writeFileSync(path.join(repo.dir, "package.json"), "{}\n");
      fs.writeFileSync(path.join(repo.dir, "notes.txt"), "n\n");
      const snap = snapshotDirty(repo.dir);
      expect(snap.map((e) => e.path)).toEqual(["notes.txt", "package.json"]);
      expect(snap[0]?.blob).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      repo.cleanup();
    }
  });

  test("snapshotDirty uses null blob for a deleted tracked file", () => {
    const repo = tmpRepo();
    try {
      fs.writeFileSync(path.join(repo.dir, "remove-me.txt"), "gone\n");
      repo.git(["add", "remove-me.txt"]);
      repo.git(["commit", "-m", "add file"]);
      fs.rmSync(path.join(repo.dir, "remove-me.txt"));
      const snap = snapshotDirty(repo.dir);
      expect(snap).toEqual([{ path: "remove-me.txt", blob: null }]);
    } finally {
      repo.cleanup();
    }
  });

  test("PREEXISTING_MAX is 1000", () => {
    expect(PREEXISTING_MAX).toBe(1000);
  });
});

describe("pre-existing scope exclusions (PLAN Step 1 acceptance)", () => {
  test("unchanged pre-existing dirty files → verified with scope.ignored", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initRepoWithPreexistingDirty(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(
          step1HandoffInput(),
        );
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        worker.service.claim(id);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "login.ts"), "export {};\n");
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");

        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("verified");
        expect(submitted.value.verification.scope.ignored.sort()).toEqual(["notes.txt", "package.json"]);
        expect(submitted.value.verification.scope.violations).toEqual([]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("editing a pre-existing file → changes_requested outside scope", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initRepoWithPreexistingDirty(repo);
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(step1HandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        worker.service.claim(id);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
        fs.writeFileSync(path.join(repo.dir, "package.json"), '{"touched":true}\n');

        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("changes_requested");
        expect(submitted.value.verification.scope.violations).toContainEqual({
          path: "package.json",
          rule: "outside src/auth/**",
        });
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("deleted-before-create still deleted → ignored; recreated → counted", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initRepoWithPreexistingDirty(repo, undefined, { skipPackageJson: true, skipNotes: true });
        fs.writeFileSync(path.join(repo.dir, "vanished.txt"), "x\n");
        repo.git(["add", "vanished.txt"]);
        repo.git(["commit", "-m", "track vanished"]);
        fs.rmSync(path.join(repo.dir, "vanished.txt"));

        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(step1HandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        worker.service.claim(id);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");

        const stillDeleted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(stillDeleted.ok).toBe(true);
        if (!stillDeleted.ok) return;
        expect(stillDeleted.value.verification.scope.ignored).toContain("vanished.txt");

        fs.writeFileSync(path.join(repo.dir, "vanished.txt"), "back\n");
        const recreated = await worker.service.verify(id);
        expect(recreated.ok).toBe(true);
        if (!recreated.ok) return;
        expect(recreated.value.verification.scope.violations.some((v) => v.path === "vanished.txt")).toBe(true);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("creator commits pre-existing file with same content → still ignored", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const body = '{"preexisting":true}\n';
        initRepoWithPreexistingDirty(repo, undefined, { packageJsonBody: body });
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(step1HandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;

        fs.writeFileSync(path.join(repo.dir, "package.json"), body);
        repo.git(["add", "package.json"]);
        repo.git(["commit", "-m", "commit pre-existing package.json"]);
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        worker.service.claim(id);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");

        const submitted = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.verification.scope.ignored).toContain("package.json");
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("dirty config at create unchanged → ignored; edited after create → protected violation", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        initRepoWithPreexistingDirty(repo, undefined, { skipPackageJson: true, skipNotes: true });
        const configPath = path.join(repo.dir, ".handproof", "config.json");
        fs.writeFileSync(
          configPath,
          `${JSON.stringify({ leaseMinutes: 31, checks: { test: { run: "test -f src/auth/ok.txt", timeoutSec: 120 } } }, null, 2)}\n`,
        );

        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(step1HandoffInput());
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        worker.service.claim(id);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");

        const unchanged = await worker.service.submit(id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(unchanged.ok).toBe(true);
        if (!unchanged.ok) return;
        expect(unchanged.value.verification.scope.ignored).toContain(".handproof/config.json");

        fs.writeFileSync(configPath, '{"leaseMinutes":99,"checks":{}}\n');
        const touched = await worker.service.verify(id);
        expect(touched.ok).toBe(true);
        if (!touched.ok) return;
        expect(touched.value.verification.scope.violations).toContainEqual({
          path: ".handproof/config.json",
          rule: "protected: .handproof/config.json",
        });
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("second worktree: matching path/blob is not ignored", () => {
    const repo = tmpRepo();
    try {
      initRepoWithPreexistingDirty(repo);
      const base = repo.git(["rev-parse", "HEAD"]);
      const pre = snapshotDirty(repo.dir);
      const notes = pre.find((e) => e.path === "notes.txt");
      expect(notes).toBeDefined();

      const wt = repo.worktree();
      fs.writeFileSync(path.join(wt, "notes.txt"), "scratch notes\n");
      const creatorRoot = fs.realpathSync(repo.dir);
      const result = changedFiles({
        cwd: wt,
        baseCommit: base,
        branch: "main",
        preexisting: pre,
        creatorWorktree: creatorRoot,
      });
      expect(result.ignored).not.toContain("notes.txt");
      expect(result.files).toContain("notes.txt");
    } finally {
      repo.cleanup();
    }
  });

  test("Phase 2-shaped row parses and verifies like before", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const paths = initRepoWithPreexistingDirty(repo, undefined, {
          skipPackageJson: true,
          skipNotes: true,
        });
        const base = repo.git(["rev-parse", "HEAD"]);
        const parsed = Handoff.parse({
          ...fullHandoffFixture,
          repo: { root: paths.root, branch: "main", baseCommit: base },
        });
        expect(parsed.repo.preexisting).toEqual([]);
        expect(parsed.repo.worktree).toBeUndefined();

        const planner = openTestService(repo, AGENTS.planner, now);
        planner.repo.insert(parsed, {
          at: parsed.createdAt,
          actor: "planner",
          type: "created",
          data: { title: parsed.title, kind: parsed.kind, to: parsed.to },
        });
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        worker.service.claim(parsed.id);
        fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, "src", "auth", "ok.txt"), "ok\n");
        const submitted = await worker.service.submit(parsed.id, {
          summary: SUMMARY,
          criteria: criteriaFor(["ac1"]),
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) return;
        expect(submitted.value.handoff.status).toBe("verified");
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("1001 untracked files → too_many_preexisting_changes and no insert", () => {
    const repo = tmpRepo();
    try {
      initRepoWithPreexistingDirty(repo, undefined, { skipPackageJson: true, skipNotes: true });
      for (let i = 0; i <= PREEXISTING_MAX; i += 1) {
        fs.writeFileSync(path.join(repo.dir, `bulk-${String(i).padStart(4, "0")}.txt`), "x\n");
      }
      const planner = openTestService(repo, AGENTS.planner);
      const result = planner.service.create(step1HandoffInput());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.error).toBe("too_many_preexisting_changes");
      expect(result.error.count).toBe(PREEXISTING_MAX + 1);
      expect(result.error.max).toBe(PREEXISTING_MAX);
      planner.close();
    } finally {
      repo.cleanup();
    }
  });

  test("handoff_create MCP result includes preexisting count", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoWithPreexistingDirty(repo);
      const config = loadConfig(paths);
      const plannerHandle = openService({ paths, config, agent: AGENTS.planner });
      const server = createServer({
        paths,
        config,
        agent: AGENTS.planner,
        service: plannerHandle.service,
      });
      const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "preexisting-create", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(transport);
      try {
        const created = await client.callTool({
          name: "handoff_create",
          arguments: step1HandoffInput(),
        });
        expect(created.isError).not.toBe(true);
        const body = structured(created);
        expect(typeof body.preexisting).toBe("number");
        expect(body.preexisting).toBeGreaterThan(0);
      } finally {
        await client.close();
        await server.close();
        plannerHandle.close();
      }
    } finally {
      repo.cleanup();
    }
  });
});
