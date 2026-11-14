import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config";
import { createServer } from "../src/server";
import { openService } from "../src/service/open";
import type { HandoffService } from "../src/service/handoffs";
import validFixture from "./fixtures/handoffs/valid.json";
import { BUN } from "./helpers/bun";
import { AGENTS, initRepoHandoffs } from "./helpers/serviceSetup";
import { tmpRepo } from "./helpers/tmpRepo";

const T0 = new Date("2026-11-03T12:00:00.000Z");
const SAME_NAME_AGENT = "phase0-same-agent";
const SAME_NAME_ROUNDS = 20;
const WORKER = path.join(import.meta.dir, "helpers", "claimWorker.ts");
const PROJECT_ROOT = path.join(import.meta.dir, "..");

interface WorkerResult {
  ok: boolean;
  id?: string;
  claimBy?: string | null;
  error?: { error: string; [k: string]: unknown };
}

function isWorkerResult(message: unknown): message is WorkerResult {
  return typeof message === "object" && message !== null && "ok" in message;
}

function spawnClaimWorker(repoDir: string, agentName: string, handoffIdOrDash: string) {
  let resolveReady!: () => void;
  let resolveResult!: (result: WorkerResult) => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const result = new Promise<WorkerResult>((resolve) => {
    resolveResult = resolve;
  });

  const proc = Bun.spawn([BUN, WORKER, repoDir, agentName, handoffIdOrDash], {
    cwd: PROJECT_ROOT,
    ipc(message) {
      if (message === "ready") {
        resolveReady();
        return;
      }
      if (isWorkerResult(message)) {
        resolveResult(message);
      }
    },
    serialization: "json",
    stdout: "ignore",
    stderr: "pipe",
  });

  return { proc, ready, result };
}

function withClock<T>(fn: (now: () => Date, advance: (m: number) => void) => T): T {
  let ms = T0.getTime();
  const now = (): Date => new Date(ms);
  const advance = (minutes: number): void => {
    ms += minutes * 60_000;
  };
  return fn(now, advance);
}

function expectErr(
  result: { ok: boolean; error?: { error: string; [k: string]: unknown } },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok || result.error === undefined) {
    throw new Error(`expected ${code}`);
  }
  expect(result.error.error).toBe(code);
}

function assertSameNameNoIdRaceResults(ra: WorkerResult, rb: WorkerResult, expectedId: string): void {
  for (const r of [ra, rb]) {
    if (r.ok) {
      expect(r.id).toBe(expectedId);
    } else {
      expect(r.error?.error).toBe("nothing_to_claim");
    }
  }
  expect([ra, rb].some((r) => r.ok)).toBe(true);
}

describe("Phase 1 review nits (PLAN Step 0)", () => {
  test(
    "same agent name: concurrent claim() with no id — winner ok; loser ok same id or nothing_to_claim; one claimed event",
    async () => {
      const repo = tmpRepo();
      try {
        const paths = initRepoHandoffs(repo);
        const config = loadConfig(paths);
        const planner = openService({ paths, config, agent: AGENTS.planner });

        for (let round = 0; round < SAME_NAME_ROUNDS; round += 1) {
          const created = planner.service.create({
            ...validFixture,
            title: `Same-name no-id round ${String(round).padStart(2, "0")}`,
          });
          expect(created.ok).toBe(true);
          if (!created.ok) return;
          const id = created.value.handoff.id;

          const a = spawnClaimWorker(repo.dir, SAME_NAME_AGENT, "-");
          const b = spawnClaimWorker(repo.dir, SAME_NAME_AGENT, "-");

          await Promise.all([a.ready, b.ready]);
          a.proc.send("go");
          b.proc.send("go");

          const [ra, rb] = await Promise.all([a.result, b.result]);

          assertSameNameNoIdRaceResults(ra, rb, id);

          await Promise.all([a.proc.exited, b.proc.exited]);

          const claimedCount = planner.repo
            .events(id)
            .filter((e) => e.type === "claimed").length;
          expect(claimedCount).toBe(1);
        }

        planner.close();
      } finally {
        repo.cleanup();
      }
    },
    120_000,
  );

  test("claimant with lapsed lease: whitespace-only update yields lease_expired after tick", () => {
    withClock((now, advance) => {
      const repo = tmpRepo();
      try {
        const paths = initRepoHandoffs(repo);
        const config = loadConfig(paths);
        const planner = openService({ paths, config, agent: AGENTS.planner, now });
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openService({ paths, config, agent: AGENTS.cursorImpl, now });
        expect(worker.service.claim(id).ok).toBe(true);
        worker.close();

        advance(31);
        const again = openService({ paths, config, agent: AGENTS.cursorImpl, now });
        expectErr(again.service.update(id, "   "), "lease_expired");
        again.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("history returns created after create, created+claimed after claim, [] for unknown ids", () => {
    withClock((now) => {
      const repo = tmpRepo();
      try {
        const paths = initRepoHandoffs(repo);
        const config = loadConfig(paths);
        const planner = openService({ paths, config, agent: AGENTS.planner, now });
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        expect(planner.service.history(id).map((e) => e.type)).toEqual(["created"]);
        planner.close();

        const worker = openService({ paths, config, agent: AGENTS.cursorImpl, now });
        expect(worker.service.claim(id).ok).toBe(true);
        const events = worker.service.history(id);
        expect(events.map((e) => e.type)).toEqual(["created", "claimed"]);
        expect(worker.service.history("h_nope")).toEqual([]);
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("handoff_claim markdown timeline lists created and claimed", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoHandoffs(repo);
      const config = loadConfig(paths);
      const plannerHandle = openService({ paths, config, agent: AGENTS.planner });
      const created = plannerHandle.service.create(validFixture);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = created.value.handoff.id;
      plannerHandle.close();

      const workerHandle = openService({ paths, config, agent: AGENTS.cursorImpl });
      const server = createServer({
        paths,
        config,
        agent: AGENTS.cursorImpl,
        service: workerHandle.service,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "claim-brief-test", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const claim = await client.callTool({ name: "handoff_claim", arguments: { id } });
        expect(claim.isError).not.toBe(true);
        const textBlock = claim.content.find((c) => c.type === "text");
        const markdown = textBlock?.type === "text" ? textBlock.text : "";
        expect(markdown).toContain("## Timeline");
        expect(markdown).toMatch(/\bcreated\b/);
        expect(markdown).toMatch(/\bclaimed\b/);
      } finally {
        await client.close();
        await server.close();
        workerHandle.close();
      }
    } finally {
      repo.cleanup();
    }
  });

  test("resource read maps db_busy to JSON-RPC -32603 with retryable data", async () => {
    const repo = tmpRepo();
    try {
      const paths = initRepoHandoffs(repo);
      const config = loadConfig(paths);
      const id = "h_stub000000000000000000000";

      const stub: HandoffService = {
        create: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        list: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        get: () => ({
          ok: false,
          error: {
            error: "db_busy",
            message: "the handproof database is busy; retry the call",
            retryable: true,
          },
        }),
        claim: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        update: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        release: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        cancel: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        inbox: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
        history: () => [],
        submit: () => Promise.resolve({ ok: false, error: { error: "not_implemented", message: "stub" } } as const),
        verify: () => Promise.resolve({ ok: false, error: { error: "not_implemented", message: "stub" } } as const),
        review: () => ({ ok: false, error: { error: "not_implemented", message: "stub" } }),
      };

      const server = createServer({
        paths,
        config,
        agent: AGENTS.cursorImpl,
        service: stub,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "db-busy-test", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        let caught: unknown;
        try {
          await client.readResource({ uri: `handoff://${id}` });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        const err = caught as { code?: number; data?: { error?: string; retryable?: boolean } };
        expect(err.code).toBe(-32603);
        expect(err.data?.error).toBe("db_busy");
        expect(err.data?.retryable).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      repo.cleanup();
    }
  });
});
