import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "../../src/config";
import { DEMO_CONFIG } from "./phase2Setup";
import { initRepoHandoffs, writeConfig } from "./serviceSetup";
import type { TmpRepo } from "./tmpRepo";

/** Repo with tracked handoffs setup plus dirty `package.json` and untracked `notes.txt` at create time. */
export function initRepoWithPreexistingDirty(
  repo: TmpRepo,
  config: Config = DEMO_CONFIG,
  opts: { skipPackageJson?: boolean; skipNotes?: boolean; packageJsonBody?: string } = {},
): ReturnType<typeof initRepoHandoffs> {
  const paths = initRepoHandoffs(repo);
  writeConfig(paths, config);
  fs.mkdirSync(path.join(repo.dir, "src", "auth"), { recursive: true });
  repo.git(["add", ".gitignore", ".handproof/config.json"]);
  repo.git(["commit", "-m", "track handoffs setup"]);
  if (!opts.skipPackageJson) {
    fs.writeFileSync(
      path.join(repo.dir, "package.json"),
      opts.packageJsonBody ?? '{"preexisting":true}\n',
    );
  }
  if (!opts.skipNotes) {
    fs.writeFileSync(path.join(repo.dir, "notes.txt"), "scratch notes\n");
  }
  return paths;
}
