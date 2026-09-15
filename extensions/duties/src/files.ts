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

/** Longer than any sensible document name and short of every filesystem's limit, leaving room for
 *  the extension and a collision suffix. */
const MAX_FILE_NAME_CHARS = 120;

/**
 * Turns a proposed document name — authored with placeholders, or written by the model — into a
 * safe basename with the right extension.
 *
 * The name reaches a filesystem and then a chat client as an attachment, so it is reduced to one
 * path segment: separators and control characters cannot survive, `..` cannot survive, and runs of
 * whitespace collapse. An empty result is the caller's problem to fall back from, so this returns
 * undefined rather than inventing a name.
 */
export function safeFileName(raw: string, extension: string): string | undefined {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  const collapsed = raw
    // Control characters and path separators never belong in a basename.
    // oxlint-disable-next-line eslint/no-control-regex -- Intentionally strips ASCII control characters from a filename.
    .replaceAll(/[\u0000-\u001f\u007f/\\]/gu, " ")
    // With the separators gone, a traversal reads as bare dot runs; drop them rather than keep
    // "`.. .. ..`" in a name the owner is meant to read.
    .replaceAll(/(?<=^|\s)\.+(?=\s|$)/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    // A leading dot would hide the file, and a trailing dot is invalid on Windows.
    .replace(/^\.+/u, "")
    .replace(/\.+$/u, "");
  if (!collapsed) {
    return undefined;
  }
  const withoutExt = collapsed.toLowerCase().endsWith(ext.toLowerCase())
    ? collapsed.slice(0, -ext.length)
    : collapsed;
  const trimmed = withoutExt.slice(0, MAX_FILE_NAME_CHARS).trim().replace(/\.+$/u, "");
  return trimmed ? `${trimmed}${ext}` : undefined;
}

/** Picks a name that is not taken in `dir`, appending ` (2)`, ` (3)`… before the extension. Two
 *  `template` steps in one run can legitimately want the same document name, and the second must
 *  not overwrite the first — `deliver` sends the path, so an overwrite would attach the wrong
 *  document rather than fail. */
export async function uniqueFileName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? name : `${base} (${attempt})${ext}`;
    const taken = await stat(path.join(dir, candidate)).then(
      () => true,
      () => false,
    );
    if (!taken) {
      return candidate;
    }
  }
  return `${base} (${Date.now()})${ext}`;
}

/** Rendered files live on disk (delivery needs a path); each run gets its own directory so a
 *  cleanup pass can drop whole runs by age without touching anything else. */
export function createRunFiles(rootDir: string) {
  const runsDir = path.join(rootDir, "runs");
  const previewsDir = path.join(rootDir, "previews");
  return {
    async runDir(runId: string): Promise<string> {
      if (!RUN_ID_RE.test(runId)) {
        throw new Error(`invalid run id "${runId}"`);
      }
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
      // Each removal is guarded on its own: one entry the OS refuses (EPERM, EBUSY, an open
      // handle) used to abort the whole pass and its count, so a single stuck run directory
      // stopped every later one from ever being swept.
      const drop = async (target: string, recursive: boolean): Promise<void> => {
        try {
          await rm(target, { recursive, force: true });
          removed += 1;
        } catch {
          // Disk space is a note, never a reason to stop sweeping the rest.
        }
      };
      for (const name of await readdir(runsDir).catch(() => [])) {
        const dir = path.join(runsDir, name);
        const info = await stat(dir).catch(() => undefined);
        if (!info?.isDirectory() || now - info.mtimeMs < olderThanMs) {
          continue;
        }
        await drop(dir, true);
      }
      for (const name of await readdir(previewsDir).catch(() => [])) {
        const file = path.join(previewsDir, name);
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile() || now - info.mtimeMs < PREVIEW_TTL_MS) {
          continue;
        }
        await drop(file, false);
      }
      return removed;
    },
  };
}
