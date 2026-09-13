import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Run ids come from run creation (a generated id), never end-user path input — but `runDir` still
 *  validates before joining, so a stray "../" can never place a run's files outside `runsDir` where
 *  `cleanup` cannot find (and therefore never removes) them. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Previews belong to no run and are not evidence: the Templates page writes a fresh one on every
 *  card render, so they are swept on their own, much shorter clock than run documents. A day is
 *  long enough that a preview the owner is still looking at is never pulled out from under them. */
export const PREVIEW_TTL_MS = 24 * 3600 * 1000;

/** Rendered files live on disk (delivery needs a path); each run gets its own directory so a
 *  cleanup pass can drop whole runs by age without touching anything else. */
export function createRunFiles(rootDir: string) {
  const runsDir = path.join(rootDir, "runs");
  const previewsDir = path.join(rootDir, "previews");
  return {
    async runDir(runId: string): Promise<string> {
      if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id "${runId}"`);
      const dir = path.join(runsDir, runId);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async previewDir(): Promise<string> {
      await mkdir(previewsDir, { recursive: true });
      return previewsDir;
    },
    /** Drops whole run directories older than `olderThanMs`, and individual preview files older
     *  than `PREVIEW_TTL_MS` — two independent clocks, one returned count. Either tree being
     *  absent is normal (nothing has rendered yet) and is not an error. */
    async cleanup(olderThanMs: number, now = Date.now()): Promise<number> {
      let removed = 0;
      for (const name of await readdir(runsDir).catch(() => [])) {
        const dir = path.join(runsDir, name);
        const info = await stat(dir).catch(() => undefined);
        if (!info?.isDirectory() || now - info.mtimeMs < olderThanMs) continue;
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
      for (const name of await readdir(previewsDir).catch(() => [])) {
        const file = path.join(previewsDir, name);
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile() || now - info.mtimeMs < PREVIEW_TTL_MS) continue;
        await rm(file, { force: true });
        removed += 1;
      }
      return removed;
    },
  };
}
