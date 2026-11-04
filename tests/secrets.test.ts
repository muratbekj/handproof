import { describe, expect, test } from "bun:test";
import { scanSecrets } from "../src/verify/secrets";
import validFixture from "./fixtures/handoffs/valid.json";
import { AGENTS, openTestService } from "./helpers/serviceSetup";
import { withPhase2Clock } from "./helpers/phase2Setup";
import { tmpRepo } from "./helpers/tmpRepo";

const AWS_EXAMPLE = "AKIAIOSFODNN7EXAMPLE";
const FIX = "remove the secret; reference it by name instead";

function expectErr(
  result: { ok: boolean; error?: { error: string; issues?: unknown; [k: string]: unknown } },
  code: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok || result.error === undefined) throw new Error(`expected ${code}`);
  expect(result.error.error).toBe(code);
  return result.error;
}

describe("scanSecrets", () => {
  test("detects aws_access_key with bounded form", () => {
    const hits = scanSecrets(`key ${AWS_EXAMPLE} here`, ["context", "summary"]);
    expect(hits).toEqual([{ path: "context.summary", pattern: "aws_access_key" }]);
  });

  test("sk_token requires 20+ chars after sk-; excludes task-runner-like tokens", () => {
    const sk20 = `sk-${"a".repeat(20)}`;
    expect(scanSecrets(sk20, ["context", "tried", 1, "outcome"])).toEqual([
      { path: "context.tried[1].outcome", pattern: "sk_token" },
    ]);
    expect(scanSecrets(`sk-${"a".repeat(19)}`, ["x"])).toEqual([]);
    expect(scanSecrets("task-runner", ["x"])).toEqual([]);
    expect(scanSecrets("multitask-worker", ["x"])).toEqual([]);
    expect(scanSecrets(`ask-${"a".repeat(20)}`, ["x"])).toEqual([]);
  });

  test("private_key vs public key header", () => {
    expect(scanSecrets("-----BEGIN RSA PRIVATE KEY-----", ["constraints", 0])).toEqual([
      { path: "constraints[0]", pattern: "private_key" },
    ]);
    expect(scanSecrets("-----BEGIN PUBLIC KEY-----", ["constraints", 0])).toEqual([]);
  });

  test("github_token length and aws overflow", () => {
    const ghp = `ghp_${"a".repeat(36)}`;
    expect(scanSecrets(ghp, ["goal"])).toEqual([{ path: "goal", pattern: "github_token" }]);
    expect(scanSecrets(`ghp_${"a".repeat(35)}`, ["goal"])).toEqual([]);
    expect(scanSecrets("AKIAIOSFODNN7EXAMPLEX", ["goal"])).toEqual([]);
  });

  test("multiple hits in one value tree", () => {
    const hits = scanSecrets(
      { goal: ghpToken(), context: { summary: `uses ${AWS_EXAMPLE}` } },
      [],
    );
    expect(hits.length).toBe(2);
  });
});

function ghpToken(): string {
  return `ghp_${"b".repeat(36)}`;
}

describe("secret_detected on service paths", () => {
  test("create refuses secrets and does not persist a row", () => {
    withPhase2Clock((now) => {
      const repo = tmpRepo();
      try {
        const ctx = openTestService(repo, AGENTS.planner, now);
        const bad = ctx.service.create({
          ...validFixture,
          context: {
            ...validFixture.context,
            summary: `Leak ${AWS_EXAMPLE} in summary text here with enough length for validation.`,
          },
        });
        const err = expectErr(bad, "secret_detected");
        const issues = err.issues as { path: string; problem: string; fix: string }[];
        expect(issues).toContainEqual({
          path: "context.summary",
          problem: "looks like an aws_access_key",
          fix: FIX,
        });
        expect(ctx.repo.list({}).length).toBe(0);
        ctx.close();
      } finally {
        repo.cleanup();
      }
    });
  });

  test("update note and submit summary use path note and summary", async () => {
    await withPhase2Clock(async (now) => {
      const repo = tmpRepo();
      try {
        const planner = openTestService(repo, AGENTS.planner, now);
        const created = planner.service.create(validFixture);
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.value.handoff.id;
        planner.close();

        const worker = openTestService(repo, AGENTS.cursorImpl, now);
        expect(worker.service.claim(id).ok).toBe(true);

        const upd = worker.service.update(id, `key ${AWS_EXAMPLE}`);
        const updErr = expectErr(upd, "secret_detected");
        expect((updErr.issues as { path: string }[])[0]?.path).toBe("note");

        const submit = await worker.service.submit(id, {
          summary: `summary ${AWS_EXAMPLE} padding text to meet minimum length requirement.`,
          criteria: [{ id: "ac1", met: true }],
        });
        const subErr = expectErr(submit, "secret_detected");
        expect((subErr.issues as { path: string }[])[0]?.path).toBe("summary");
        worker.close();
      } finally {
        repo.cleanup();
      }
    });
  });
});
