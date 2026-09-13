import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Run ids come from run creation (a generated id), never end-user path input — but `runDir` still
 *  validates before joining, so a stray "../" can never place a run's files outside `runsDir` where
 *  `cleanup` cannot find (and therefore never removes) them. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Rendered files live on disk (delivery needs a path); each run gets its own directory so a
 *  cleanup pass can drop whole runs by age without touching anything else. */
export function createRunFiles(rootDir: string) {
  const runsDir = path.join(rootDir, "runs");
  return {
    async runDir(runId: string): Promise<string> {
      if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id "${runId}"`);
      const dir = path.join(runsDir, runId);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async previewDir(): Promise<string> {
      const dir = path.join(rootDir, "previews");
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(olderThanMs: number, now = Date.now()): Promise<number> {
      let removed = 0;
      let names: string[] = [];
      try {
        names = await readdir(runsDir);
      } catch {
        return 0;
      }
      for (const name of names) {
        const dir = path.join(runsDir, name);
        const info = await stat(dir).catch(() => undefined);
        if (!info?.isDirectory() || now - info.mtimeMs < olderThanMs) continue;
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
  };
}
