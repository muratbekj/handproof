import { loadConfig, resolveAgent, resolveRepo } from "../../src/config";
import { openService } from "../../src/service/open";

const [repoPath, agentName, handoffIdArg] = Bun.argv.slice(2);

if (repoPath === undefined || agentName === undefined || handoffIdArg === undefined) {
  throw new Error("usage: claimWorker.ts <repoPath> <agentName> <handoffId|->");
}

const harness = agentName.includes("cursor") ? "cursor" : "claude-code";
const env: Record<string, string | undefined> = {
  ...process.env,
  HANDPROOF_REPO: repoPath,
  HANDPROOF_AGENT: agentName,
  HANDPROOF_HARNESS: harness,
};

const paths = resolveRepo({ cwd: repoPath, env });
const config = loadConfig(paths);
const agent = resolveAgent(env);
const handle = openService({ paths, config, agent });

function ipcSend(message: unknown): void {
  if (typeof process.send !== "function") {
    throw new Error("IPC unavailable");
  }
  process.send(message);
}

ipcSend("ready");

await new Promise<void>((resolve) => {
  function onMessage(msg: unknown): void {
    if (msg === "go") {
      process.removeListener("message", onMessage);
      resolve();
    }
  }
  process.on("message", onMessage);
});

const result = handoffIdArg === "-" ? handle.service.claim() : handle.service.claim(handoffIdArg);
if (result.ok) {
  ipcSend({
    ok: true,
    id: result.value.id,
    claimBy: result.value.claim?.by.name ?? null,
  });
} else {
  ipcSend({ ok: false, error: result.error });
}
handle.close();
